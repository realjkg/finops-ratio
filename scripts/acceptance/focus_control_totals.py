#!/usr/bin/env python3
"""Independent control totals for a FOCUS CSV (Slice 2b acceptance run).

DESIGN: docs/evidence/slice-2b/DESIGN.md section 4.

Deliberately independent of everything it checks. It is Python, standard
library only, and shares no code with the ingestion worker (TypeScript,
csv-parse), the staging converter (JavaScript), Postgres or the API. It reads
the UPSTREAM file, never the staged copy.

  python3 focus_control_totals.py [--expect-sha256 HEX] [--row-id-column Id] [--rows] [--focus-version 1.0]
                                 [--provider NAME]... FILE

Prints one JSON document. Per (billing period, currency) it reports:
rowCount, billedCost, effectiveCost, effectiveCostNulls and rowDigest.

It also prints `columns`, which says how each upstream column reaches the
API: `mapped` to a named field, returned in `extraColumns`, or `notReturned`
(none).

With --rows it adds `rows`: for every upstream record, in file order, the
exact API row the worker must publish (the GET /api/v1/costs/published
contract, publishedCosts.ts):
- money and quantities in numeric::text form;
- billingPeriod as YYYY-MM-DD;
- timestamps as YYYY-MM-DDTHH:MM:SS.ffffffZ (UTC);
- a SQL null (unquoted NULL) or an empty field becomes null, or is omitted
  from extraColumns;
- every other upstream column is in extraColumns, verbatim.

The acceptance run compares every API row with this, keyed by the row id.

With --provider NAME (repeatable; issue #62) only the records whose
ProviderName is EXACTLY one of the names (case-sensitive, no trimming) are
counted in `totals` and `rows`. Every other record is still read and
validated, and counted per billing period under `excluded` (with a count
per provider); `providerFilter` repeats the names. A NULL or empty
ProviderName is refused under a filter: the worker quarantines such a
batch, so its outcome is not a row-level exclusion the control could state.

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
import datetime
import hashlib
import json
import re
import sys

REQUIRED = ('BillingPeriodStart', 'BillingCurrency', 'BilledCost', 'EffectiveCost')
DECIMAL_RE = re.compile(r'^(-?)([0-9]+)(?:\.([0-9]+))?$')

# How an upstream FOCUS column reaches GET /api/v1/costs/published
# (src/server/costs/publishedCosts.ts). This is the API CONTRACT, written down
# here independently; it is not imported from the worker. Every column not
# listed here is returned verbatim in extraColumns when it is neither null nor
# empty. UsageQuantity and UsageUnit are fallbacks for a null ConsumedQuantity
# or ConsumedUnit.
API_FIELD = {
    'BillingPeriodStart': 'billingPeriod',
    'ChargePeriodStart': 'chargePeriodStart',
    'ChargePeriodEnd': 'chargePeriodEnd',
    'BilledCost': 'billedCost',
    'EffectiveCost': 'effectiveCost',
    'ListCost': 'listCost',
    'ContractedCost': 'contractedCost',
    'BillingCurrency': 'billingCurrency',
    'ProviderName': 'providerName',
    'ServiceName': 'serviceName',
    'ServiceCategory': 'serviceCategory',
    'ChargeCategory': 'chargeCategory',
    'ResourceId': 'resourceId',
    'SubAccountId': 'subAccountId',
    'BillingAccountId': 'billingAccountId',
    'ConsumedQuantity': 'usageQuantity',
    'UsageQuantity': 'usageQuantity',
    'ConsumedUnit': 'usageUnit',
    'UsageUnit': 'usageUnit',
    'PricingQuantity': 'pricingQuantity',
    'PricingUnit': 'pricingUnit',
}
# Upstream columns whose values the API never returns (none: every column is
# either mapped or returned in extraColumns). Pinned in control-totals.json.
NOT_RETURNED = ()
TIMESTAMP_RE = re.compile(
    r'^([0-9]{4})-([0-9]{2})-([0-9]{2})[ T]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?(Z|[+-][0-9]{2}:[0-9]{2})?$'
)
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


def parse_timestamp(text):
    """A FOCUS date-time with seconds (no offset = UTC) -> an aware UTC datetime.

    A value whose UTC instant falls outside years 1..9999 (e.g. 9999-12-31T23:00:00-02:00) cannot be
    held by datetime; it is refused as a ControlTotalsError, never an OverflowError (PR #68 review).
    The worker accepts such a value, so the control fails closed there ("stricter on formats").
    """
    m = TIMESTAMP_RE.match(text)
    if not m:
        raise ControlTotalsError('not a date-time with seconds')
    y, mo, d, h, mi, s, frac, zone = m.groups()
    try:
        tz = datetime.timezone.utc
        if zone and zone != 'Z':
            sign = -1 if zone[0] == '-' else 1
            hh, mm = int(zone[1:3]), int(zone[4:6])
            if hh > 14 or mm > 59 or (hh == 14 and mm != 0):
                raise ValueError('offset')
            tz = datetime.timezone(sign * datetime.timedelta(hours=hh, minutes=mm))
        t = datetime.datetime(int(y), int(mo), int(d), int(h), int(mi), int(s), int((frac or '').ljust(6, '0')), tzinfo=tz)
    except ValueError:
        raise ControlTotalsError('not a valid date-time') from None
    try:
        return t.astimezone(datetime.timezone.utc)
    except OverflowError:
        raise ControlTotalsError('not representable in UTC within years 1..9999') from None


def format_utc(t):
    """As the API's to_char(... AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') formats it.

    The year is zero-padded to four digits explicitly: strftime('%Y') does not pad years below 1000
    on every platform (PR #68 review, Copilot r4178585902).
    """
    return f'{t.year:04d}-{t.month:02d}-{t.day:02d}T{t.hour:02d}:{t.minute:02d}:{t.second:02d}.{t.microsecond:06d}Z'


def format_timestamp(text):
    """'2024-09-18 22:00:00' (no offset = UTC) -> '2024-09-18T22:00:00.000000Z', as the API's to_char formats it."""
    return format_utc(parse_timestamp(text))


def classify_columns(header):
    return {
        'mapped': {c: API_FIELD[c] for c in header if c in API_FIELD},
        'extra': [c for c in header if c not in API_FIELD and c not in NOT_RETURNED],
        'notReturned': [c for c in header if c in NOT_RETURNED],
    }


def expected_row(rec, pos, header, period, focus_version, n):
    """The API row the worker must publish for this UPSTREAM record (the per-row contract)."""
    def value(col):
        """Upstream text, or None for a SQL null (unquoted NULL), an empty field or a missing column."""
        if col not in pos:
            return None
        f = rec[pos[col]]
        return None if _is_null(f) or f[0] == '' else f[0]

    def dec(col):
        v = value(col)
        if v is None:
            return None
        try:
            return canonical_decimal(v)
        except ControlTotalsError:
            raise ControlTotalsError(f'record {n}: {col} is not a plain decimal') from None

    def ts(col):
        v = value(col)
        if v is None:
            raise ControlTotalsError(f'record {n}: {col} is null')
        try:
            return parse_timestamp(v)
        except ControlTotalsError as e:
            raise ControlTotalsError(f'record {n}: {col}: {e}') from None

    def first(*vals):
        return next((v for v in vals if v is not None), None)

    # The worker's validateRow refuses a C0 control other than TAB/LF/CR in ANY value
    # (INVALID_CHARACTER, validate.ts) and an end before the start (CHARGE_PERIOD_INVERTED).
    # The batch then quarantines, so --rows must not predict a publication (Copilot F2).
    for name, (text, _quoted) in zip(header, rec):
        if any(ord(ch) < 0x20 and ch not in '\t\n\r' for ch in text):
            raise ControlTotalsError(f'record {n}: {name} contains a control character (only TAB, CR and LF are allowed)')
    start, end = ts('ChargePeriodStart'), ts('ChargePeriodEnd')
    # Compared as instants (never as text) at full microsecond precision, as Postgres stores and
    # the cost_facts_charge_period CHECK compares them (PR #69 review: the millisecond rule was wrong).
    # TIMESTAMP_RE allows at most 6 fraction digits, so no rounding is needed here; the worker rounds
    # 7-9 digits as Postgres does (timestamp.ts epochUs).
    if end < start:
        raise ControlTotalsError(f'record {n}: ChargePeriodEnd is before ChargePeriodStart')

    return {
        'billingPeriod': period,
        'chargePeriodStart': format_utc(start),
        'chargePeriodEnd': format_utc(end),
        'billedCost': dec('BilledCost'),
        'effectiveCost': dec('EffectiveCost'),
        'listCost': dec('ListCost'),
        'contractedCost': dec('ContractedCost'),
        'billingCurrency': value('BillingCurrency'),
        'providerName': value('ProviderName'),
        'serviceName': value('ServiceName'),
        'serviceCategory': value('ServiceCategory'),
        'chargeCategory': value('ChargeCategory'),
        'resourceId': value('ResourceId'),
        'subAccountId': value('SubAccountId'),
        'billingAccountId': value('BillingAccountId'),
        'usageQuantity': first(dec('ConsumedQuantity'), dec('UsageQuantity')),
        'usageUnit': first(value('ConsumedUnit'), value('UsageUnit')),
        'pricingQuantity': dec('PricingQuantity'),
        'pricingUnit': value('PricingUnit'),
        'focusVersion': focus_version,
        'extraColumns': {c: value(c) for c in header if c not in API_FIELD and c not in NOT_RETURNED and value(c) is not None},
    }


def compute(data, row_id_column='Id', rows=False, focus_version='1.0', providers=None):
    records = tokenize(data)
    header = [t for t, _ in records[0]]
    if len(set(header)) != len(header):
        raise ControlTotalsError('duplicate column name in the header')
    pos = {name: i for i, name in enumerate(header)}
    required = REQUIRED + (row_id_column,)
    if providers is not None:
        if not providers or any(not isinstance(p, str) or p == '' for p in providers):
            raise ControlTotalsError('a provider filter needs non-empty provider names')
        required = required + ('ProviderName',)
    for col in required:
        if col not in pos:
            raise ControlTotalsError(f'required column {col} is missing')
    excluded = {}
    data_rows = records[1:]
    if not data_rows:
        raise ControlTotalsError('no data rows')
    null_tokens = {}
    expected_rows = []
    seen_ids = set()
    groups = {}
    for n, rec in enumerate(data_rows, start=2):
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

        if providers is not None:
            provider_field = rec[pos['ProviderName']]
            if _is_null(provider_field) or provider_field[0] == '':
                raise ControlTotalsError(f'record {n}: ProviderName is null or empty')
            if provider_field[0] not in providers:
                if rows:
                    # The worker validates the whole row BEFORE the provider check (load.ts), so an
                    # invalid foreign record is a validation error, not an exclusion (PR #67 review).
                    expected_row(rec, pos, header, period, focus_version, n)
                    if id_field[0] in seen_ids:
                        raise ControlTotalsError(f'record {n}: {row_id_column} is not unique')
                    seen_ids.add(id_field[0])
                e = excluded.setdefault(period, {})
                e[provider_field[0]] = e.get(provider_field[0], 0) + 1
                continue

        g = groups.setdefault((period, currency), {'rows': 0, 'billed': [], 'effective': [], 'nulls': 0, 'lines': []})
        g['rows'] += 1
        g['billed'].append(billed)
        if effective is None:
            g['nulls'] += 1
        else:
            g['effective'].append(effective)
        eff_text = '\\N' if effective is None else effective
        g['lines'].append(f'{id_field[0]}\t{billed}\t{eff_text}\n')
        if rows:
            if id_field[0] in seen_ids:
                raise ControlTotalsError(f'record {n}: {row_id_column} is not unique')
            seen_ids.add(id_field[0])
            expected_rows.append(expected_row(rec, pos, header, period, focus_version, n))

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
    doc = {
        'type': 'ratio.focus-control-totals',
        'version': 1,
        'input': {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'dataRows': len(data_rows)},
        'nullTokens': dict(sorted(null_tokens.items())),
        'columns': classify_columns(header),
        'totals': totals,
    }
    if providers is not None:
        doc['providerFilter'] = list(providers)
        doc['excluded'] = [
            {
                'billingPeriod': period,
                'rowCount': str(sum(excluded[period].values())),
                'providers': {name: str(count) for name, count in sorted(excluded[period].items())},
            }
            for period in sorted(excluded)
        ]
    if rows:
        doc['rows'] = expected_rows
    return doc


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ControlTotalsError(f'usage: {message}')


def main(argv):
    parser = _Parser(prog='focus_control_totals.py', add_help=False)
    parser.add_argument('--expect-sha256')
    parser.add_argument('--row-id-column', default='Id')
    parser.add_argument('--rows', action='store_true')
    parser.add_argument('--focus-version', default='1.0')
    parser.add_argument('--provider', action='append', dest='providers')
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
        doc = compute(data, row_id_column=args.row_id_column, rows=args.rows, focus_version=args.focus_version, providers=args.providers)
    except ControlTotalsError as e:
        print(f'refused: {e}', file=sys.stderr)
        return 1
    # --rows prints one row per upstream record: compact, so a 10k file stays a few MB.
    print(json.dumps(doc, separators=(',', ':')) if args.rows else json.dumps(doc, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
