"""P1: unit tests of the independent control-total calculator (Slice 2b).

Run: python3 -m unittest discover -s scripts/acceptance -p 'test_*.py'
(npm test runs this through scripts/acceptance/controlTotals.test.mjs.)
Standard library only.
"""
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import focus_control_totals as fct  # noqa: E402

HEADER = '"BillingPeriodStart","BillingCurrency","BilledCost","EffectiveCost","Id","Note"\n'


def csv_bytes(*rows, header=HEADER):
    return (header + ''.join(r + '\n' for r in rows)).encode('utf-8')


class TokenizerTests(unittest.TestCase):
    def test_quoted_and_unquoted_fields_keep_their_quoting(self):
        recs = fct.tokenize(b'a,"b","c,d","e""f",NULL,"NULL",\n')
        self.assertEqual(recs, [[('a', False), ('b', True), ('c,d', True), ('e"f', True), ('NULL', False), ('NULL', True), ('', False)]])

    def test_last_record_without_newline_and_embedded_newline_in_quotes(self):
        self.assertEqual(fct.tokenize(b'x,"1\n2"\ny,3'), [[('x', False), ('1\n2', True)], [('y', False), ('3', False)]])

    def test_fails_closed(self):
        for bad in [b'a,b\r\nc,d\n', b'a,"b\n', b'a,"b"c\n', b'a,b"c\n', b'', b'\xff\xfe,a\n']:
            with self.subTest(bad=bad):
                with self.assertRaises(fct.ControlTotalsError):
                    fct.tokenize(bad)


class DecimalTests(unittest.TestCase):
    def test_sum_uses_the_largest_scale_like_postgres(self):
        self.assertEqual(fct.sum_decimals(['0.10', '0.2']), '0.30')
        self.assertEqual(fct.sum_decimals(['1', '0.001']), '1.001')
        self.assertEqual(fct.sum_decimals(['-1.5', '1.5']), '0.0')
        self.assertEqual(fct.sum_decimals(['-0.00000080000', '0.00000000001']), '-0.00000079999')
        self.assertEqual(fct.sum_decimals([]), '0')

    def test_exact_beyond_float_precision(self):
        values = ['0.1'] * 10 + ['12345678901234567890.123456789012345678']
        self.assertEqual(fct.sum_decimals(values), '12345678901234567891.123456789012345678')

    def test_canonical_form_is_postgres_numeric_text(self):
        self.assertEqual(fct.canonical_decimal('007.50'), '7.50')
        self.assertEqual(fct.canonical_decimal('-0.000'), '0.000')
        self.assertEqual(fct.canonical_decimal('-12.30'), '-12.30')
        self.assertEqual(fct.canonical_decimal('0'), '0')

    def test_refuses_anything_but_a_plain_decimal(self):
        for bad in ['1e3', 'NaN', 'Infinity', '1.', '.5', '', ' 1', '+1', '1,5', '--1', 'NULL']:
            with self.subTest(bad=bad):
                with self.assertRaises(fct.ControlTotalsError):
                    fct.parse_decimal(bad)


class ComputeTests(unittest.TestCase):
    def test_totals_per_period_and_currency(self):
        data = csv_bytes(
            '"2024-09-01 00:00:00","USD",1.10,1.00,"a","x"',
            '"2024-09-01 00:00:00","USD",-0.25,NULL,"b",NULL',
            '"2024-09-01 00:00:00","EUR",3,3.000,"c","NULL"',
            '"2024-10-01 00:00:00","USD",0.24000000000,0.00000000000,7,""',
        )
        doc = fct.compute(data)
        self.assertEqual(doc['input'], {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'dataRows': 4})
        totals = {(t['billingPeriod'], t['billingCurrency']): t for t in doc['totals']}
        self.assertEqual([(t['billingPeriod'], t['billingCurrency']) for t in doc['totals']], [('2024-09-01', 'EUR'), ('2024-09-01', 'USD'), ('2024-10-01', 'USD')])
        usd = totals[('2024-09-01', 'USD')]
        self.assertEqual((usd['rowCount'], usd['billedCost'], usd['effectiveCost'], usd['effectiveCostNulls']), ('2', '0.85', '1.00', '1'))
        eur = totals[('2024-09-01', 'EUR')]
        self.assertEqual((eur['rowCount'], eur['billedCost'], eur['effectiveCost'], eur['effectiveCostNulls']), ('1', '3', '3.000', '0'))
        lines = sorted(['a\t1.10\t1.00\n', 'b\t-0.25\t\\N\n'], key=lambda s: s.encode())
        self.assertEqual(usd['rowDigest'], hashlib.sha256(''.join(lines).encode()).hexdigest())
        oct_ = totals[('2024-10-01', 'USD')]
        self.assertEqual(oct_['rowDigest'], hashlib.sha256(b'7\t0.24000000000\t0.00000000000\n').hexdigest())
        # Only UNQUOTED NULL is a SQL null; the quoted "NULL" is a string.
        self.assertEqual(doc['nullTokens'], {'EffectiveCost': 1, 'Note': 1})

    def test_values_are_digested_in_numeric_text_form(self):
        a = fct.compute(csv_bytes('"2024-09-01 00:00:00","USD",007.50,-0.0,"a",""'))
        b = fct.compute(csv_bytes('"2024-09-01 00:00:00","USD",7.50,0.0,"a",""'))
        self.assertEqual(a['totals'][0]['rowDigest'], b['totals'][0]['rowDigest'])

    def test_the_digest_sees_a_value_moved_between_rows(self):
        a = fct.compute(csv_bytes('"2024-09-01 00:00:00","USD",1,1,"a",""', '"2024-09-01 00:00:00","USD",2,2,"b",""'))
        b = fct.compute(csv_bytes('"2024-09-01 00:00:00","USD",2,1,"a",""', '"2024-09-01 00:00:00","USD",1,2,"b",""'))
        self.assertEqual(a['totals'][0]['billedCost'], b['totals'][0]['billedCost'])
        self.assertNotEqual(a['totals'][0]['rowDigest'], b['totals'][0]['rowDigest'])

    def test_period_forms_accepted(self):
        for p in ['"2024-09-01"', '"2024-09-01T00:00:00Z"', '"2024-09-01 00:00:00.000"', '"2024-09-01T00:00:00+00:00"']:
            with self.subTest(p=p):
                doc = fct.compute(csv_bytes(f'{p},"USD",1,1,"a",""'))
                self.assertEqual(doc['totals'][0]['billingPeriod'], '2024-09-01')

    def test_fails_closed(self):
        bad_rows = {
            'billed NULL': '"2024-09-01 00:00:00","USD",NULL,1,"a",""',
            'billed quoted NULL': '"2024-09-01 00:00:00","USD","NULL",1,"a",""',
            'billed empty': '"2024-09-01 00:00:00","USD",,1,"a",""',
            'billed exponent': '"2024-09-01 00:00:00","USD",1e3,1,"a",""',
            'effective empty string': '"2024-09-01 00:00:00","USD",1,"","a",""',
            'not first of month': '"2024-09-02 00:00:00","USD",1,1,"a",""',
            'not midnight': '"2024-09-01 01:00:00","USD",1,1,"a",""',
            'period offset': '"2024-09-01T00:00:00+01:00","USD",1,1,"a",""',
            'month 13': '"2024-13-01 00:00:00","USD",1,1,"a",""',
            'currency': '"2024-09-01 00:00:00","usd",1,1,"a",""',
            'currency NULL': '"2024-09-01 00:00:00",NULL,1,1,"a",""',
            'id NULL': '"2024-09-01 00:00:00","USD",1,1,NULL,""',
            'ragged': '"2024-09-01 00:00:00","USD",1,1,"a"',
        }
        for name, row in bad_rows.items():
            with self.subTest(name=name):
                with self.assertRaises(fct.ControlTotalsError):
                    fct.compute(csv_bytes(row))

    def test_header_problems_fail_closed(self):
        for header in [
            '"BillingPeriodStart","BillingCurrency","BilledCost","EffectiveCost","Id","Id"\n',
            '"BillingPeriodStart","BillingCurrency","BilledCost","Id","Note","Other"\n',
        ]:
            with self.subTest(header=header):
                with self.assertRaises(fct.ControlTotalsError):
                    fct.compute(csv_bytes('"2024-09-01 00:00:00","USD",1,1,"a",""', header=header))
        with self.assertRaises(fct.ControlTotalsError):
            fct.compute(HEADER.encode())  # no data rows

    def test_row_id_column_is_configurable(self):
        header = '"BillingPeriodStart","BillingCurrency","BilledCost","EffectiveCost","RowKey"\n'
        doc = fct.compute(csv_bytes('"2024-09-01 00:00:00","USD",1,1,"k1"', header=header), row_id_column='RowKey')
        self.assertEqual(doc['totals'][0]['rowDigest'], hashlib.sha256(b'k1\t1\t1\n').hexdigest())


class MainTests(unittest.TestCase):
    def run_main(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = fct.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_expect_sha256(self):
        data = csv_bytes('"2024-09-01 00:00:00","USD",1,1,"a",""')
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'f.csv')
            with open(p, 'wb') as fh:
                fh.write(data)
            code, out, _ = self.run_main(['--expect-sha256', hashlib.sha256(data).hexdigest(), p])
            self.assertEqual(code, 0)
            doc = json.loads(out)
            self.assertEqual(doc['type'], 'ratio.focus-control-totals')
            self.assertEqual(doc['version'], 1)
            self.assertEqual(doc['totals'][0]['rowCount'], '1')
            code, out, err = self.run_main(['--expect-sha256', '0' * 64, p])
            self.assertEqual(code, 2)
            self.assertEqual(out, '')
            self.assertIn('sha256', err.lower())

    def test_bad_input_exits_1_without_output(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'f.csv')
            with open(p, 'wb') as fh:
                fh.write(csv_bytes('"2024-09-01 00:00:00","USD",NULL,1,"a",""'))
            code, out, _ = self.run_main([p])
            self.assertEqual(code, 1)
            self.assertEqual(out, '')


if __name__ == '__main__':
    unittest.main()
