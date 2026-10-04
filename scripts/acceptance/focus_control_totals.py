#!/usr/bin/env python3
"""Independent control totals for a FOCUS CSV (Slice 2b acceptance run).

DESIGN: docs/evidence/slice-2b/DESIGN.md section 4.

Deliberately independent of everything it checks. It is Python, standard
library only, and shares no code with the ingestion worker (TypeScript,
csv-parse), the staging converter (JavaScript), Postgres or the API. It reads
the UPSTREAM file, never the staged copy.

  python3 focus_control_totals.py [--expect-sha256 HEX] [--row-id-column Id] FILE

Prints one JSON document. Per (billing period, currency) it reports:
rowCount, billedCost, effectiveCost, effectiveCostNulls and rowDigest.

Exit codes: 0 ok; 1 the input is not what this tool accepts (nothing is
printed); 2 usage error or SHA-256 mismatch.

Rules (fail closed):
- CSV is RFC 4180 with LF records. CR anywhere outside quotes, an
  unterminated quote, bytes after a closing quote or a stray quote is an
  error.
- An UNQUOTED field whose text is exactly NULL is a SQL null. A quoted
  "NULL" is the string NULL.
- BilledCost must be a plain decimal (-?digits[.digits]); it can be neither
  null nor empty. EffectiveCost is a plain decimal or null (counted, not
  summed). Nothing else is accepted: no exponent, no sign '+', no spaces.
- BillingPeriodStart must be the first of a month at midnight (UTC).
  BillingCurrency must be three capital letters. The row id must not be null.
- Money is exact integer arithmetic. A value is (unscaled int, scale). A sum
  is taken at the largest scale seen, which is Postgres's rule for
  sum(numeric). No float, no decimal.Context.
- rowDigest = SHA-256 of the lines "<id>\t<billed>\t<effective or \\N>\n",
  sorted by their UTF-8 bytes, with values in numeric::text form (no
  leading zeros, no negative zero).
"""
import argparse
import hashlib
import json
import re
import sys

REQUIRED = ('BillingPeriodStart', 'BillingCurrency', 'BilledCost', 'EffectiveCost')
DECIMAL_RE = re.compile(r'^(-?)([0-9]+)(?:\.([0-9]+))?$')
PERIOD_RE = re.compile(r'^([0-9]{4})-(0[1-9]|1[0-2])-01(?:[ T]00:00:00(?:\.0+)?(?:Z|[+-]00:?00)?)?$')
CURRENCY_RE = re.compile(r'^[A-Z]{3}$')


class ControlTotalsError(Exception):
    """The input is not what this tool accepts. The message never quotes a cell value."""


def tokenize(data):
    """Returns a list of records; each record is a list of (text, quoted) fields."""
    if not data:
        raise ControlTotalsError('empty input')
    try:
        text = data.decode('utf-8', errors='strict')
    except UnicodeDecodeError as e:
        raise ControlTotalsError(f'input is not valid UTF-8 (byte {e.start})') from None
    records = []
    record = []
    field = []
    quoted = False
    in_quotes = False
    after_quote = False
    i = 0
    n = len(text)
    line = 1
    while i < n:
        c = text[i]
        if in_quotes:
            if c == '"':
                if i + 1 < n and text[i + 1] == '"':
                    field.append('"')
                    i += 2
                    continue
                in_quotes = False
                after_quote = True
            else:
                if c == '\n':
                    line += 1
                field.append(c)
            i += 1
            continue
        if c == ',':
            record.append((''.join(field), quoted))
            field, quoted, after_quote = [], False, False
        elif c == '\n':
            record.append((''.join(field), quoted))
            records.append(record)
            record, field, quoted, after_quote = [], [], False, False
            line += 1
        elif c == '\r':
            raise ControlTotalsError(f'carriage return on line {line}')
        elif after_quote:
            raise ControlTotalsError(f'characters after a closing quote on line {line}')
        elif c == '"':
            if field:
                raise ControlTotalsError(f'stray quote inside an unquoted field on line {line}')
            in_quotes = True
            quoted = True
        else:
            field.append(c)
        i += 1
    if in_quotes:
        raise ControlTotalsError('unterminated quoted field at end of input')
    if field or record or quoted:
        record.append((''.join(field), quoted))
        records.append(record)
    return records


def parse_decimal(text):
    """'-12.340' -> (-12340, 3). Plain decimals only."""
    m = DECIMAL_RE.match(text) if isinstance(text, str) else None
    if not m:
        raise ControlTotalsError('not a plain decimal number')
    sign, whole, frac = m.group(1), m.group(2), m.group(3) or ''
    unscaled = int(whole + frac)
    return (-unscaled if sign else unscaled, len(frac))


def format_decimal(unscaled, scale):
    sign = '-' if unscaled < 0 else ''
    digits = str(abs(unscaled))
    if scale == 0:
        return sign + digits
    digits = digits.rjust(scale + 1, '0')
    return f'{sign}{digits[:-scale]}.{digits[-scale:]}'


def sum_decimals(values):
    parsed = [parse_decimal(v) for v in values]
    scale = max((s for _, s in parsed), default=0)
    total = sum(u * 10 ** (scale - s) for u, s in parsed)
    return format_decimal(total, scale)


def canonical_decimal(text):
    return format_decimal(*parse_decimal(text))


def _is_null(field):
    text, quoted = field
    return not quoted and text == 'NULL'


def compute(data, row_id_column='Id'):
    records = tokenize(data)
    header = [t for t, _ in records[0]]
    if len(set(header)) != len(header):
        raise ControlTotalsError('duplicate column name in the header')
    pos = {name: i for i, name in enumerate(header)}
    for col in REQUIRED + (row_id_column,):
        if col not in pos:
            raise ControlTotalsError(f'required column {col} is missing')
    rows = records[1:]
    if not rows:
        raise ControlTotalsError('no data rows')
    null_tokens = {}
    groups = {}
    for n, rec in enumerate(rows, start=2):
        if len(rec) != len(header):
            raise ControlTotalsError(f'record {n} has {len(rec)} fields, the header has {len(header)}')
        for name, field in zip(header, rec):
            if _is_null(field):
                null_tokens[name] = null_tokens.get(name, 0) + 1

        period_field = rec[pos['BillingPeriodStart']]
        m = None if _is_null(period_field) else PERIOD_RE.match(period_field[0])
        if not m:
            raise ControlTotalsError(f'record {n}: BillingPeriodStart is not the first of a month at midnight')
        period = f'{m.group(1)}-{m.group(2)}-01'

        cur_field = rec[pos['BillingCurrency']]
        if _is_null(cur_field) or not CURRENCY_RE.match(cur_field[0]):
            raise ControlTotalsError(f'record {n}: BillingCurrency is not a three-letter code')
        currency = cur_field[0]

        billed_field = rec[pos['BilledCost']]
        if _is_null(billed_field):
            raise ControlTotalsError(f'record {n}: BilledCost is null')
        try:
            billed = canonical_decimal(billed_field[0])
        except ControlTotalsError:
            raise ControlTotalsError(f'record {n}: BilledCost is not a plain decimal') from None

        eff_field = rec[pos['EffectiveCost']]
        if _is_null(eff_field):
            effective = None
        else:
            try:
                effective = canonical_decimal(eff_field[0])
            except ControlTotalsError:
                raise ControlTotalsError(f'record {n}: EffectiveCost is not a plain decimal') from None

        id_field = rec[pos[row_id_column]]
        if _is_null(id_field):
            raise ControlTotalsError(f'record {n}: {row_id_column} is null')

        g = groups.setdefault((period, currency), {'rows': 0, 'billed': [], 'effective': [], 'nulls': 0, 'lines': []})
        g['rows'] += 1
        g['billed'].append(billed)
        if effective is None:
            g['nulls'] += 1
        else:
            g['effective'].append(effective)
        eff_text = '\\N' if effective is None else effective
        g['lines'].append(f'{id_field[0]}\t{billed}\t{eff_text}\n')

    totals = []
    for (period, currency) in sorted(groups):
        g = groups[(period, currency)]
        lines = sorted(g['lines'], key=lambda s: s.encode('utf-8'))
        totals.append({
            'billingPeriod': period,
            'billingCurrency': currency,
            'rowCount': str(g['rows']),
            'billedCost': sum_decimals(g['billed']),
            'effectiveCost': sum_decimals(g['effective']),
            'effectiveCostNulls': str(g['nulls']),
            'rowDigest': hashlib.sha256(''.join(lines).encode('utf-8')).hexdigest(),
        })
    return {
        'type': 'ratio.focus-control-totals',
        'version': 1,
        'input': {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'dataRows': len(rows)},
        'nullTokens': dict(sorted(null_tokens.items())),
        'totals': totals,
    }


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ControlTotalsError(f'usage: {message}')


def main(argv):
    parser = _Parser(prog='focus_control_totals.py', add_help=False)
    parser.add_argument('--expect-sha256')
    parser.add_argument('--row-id-column', default='Id')
    parser.add_argument('file')
    try:
        args = parser.parse_args(argv)
    except ControlTotalsError as e:
        print(str(e), file=sys.stderr)
        return 2
    try:
        with open(args.file, 'rb') as fh:
            data = fh.read()
    except OSError as e:
        print(f'cannot read the input: {e.strerror}', file=sys.stderr)
        return 2
    if args.expect_sha256 is not None:
        actual = hashlib.sha256(data).hexdigest()
        if actual != args.expect_sha256.lower():
            print(f'SHA-256 mismatch: expected {args.expect_sha256}, got {actual}', file=sys.stderr)
            return 2
    try:
        doc = compute(data, row_id_column=args.row_id_column)
    except ControlTotalsError as e:
        print(f'refused: {e}', file=sys.stderr)
        return 1
    print(json.dumps(doc, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
