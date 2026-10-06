// PDF export (Ratio v2 Wave 2b). Server-rendered, point-in-time "Initiative Cost
// Report" the executive shares with a board / finance review. Built with
// @react-pdf/renderer (no headless browser) and the bundled Helvetica/Courier
// faces — Courier stands in for JetBrains Mono on numbers, Helvetica for labels
// — so the renderer stays fully offline (CI-safe, no font fetch). Layout mirrors
// the approved Section 3b mockup: header, 2x2 KPI grid, initiative table, footer.
//
// Server-only: imported exclusively by the /api/report/snapshot route so the
// renderer never leaks into the client bundle.

import {
  Document,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from '@react-pdf/renderer';
import { formatRatio, formatUSD } from '@/lib/format';
import { COST_CATEGORIES } from '@/outcomes/types';
import { buildReportModel, type ReportModel, type ReportRow } from './reportModel';

// Design tokens (durable, exact) reused for the print surface.
const TOKEN = {
  value: '#00e09e', // savings / efficiency
  cost: '#ff5c72', // spend
  gate: '#7c8dff', // pending approval
  text: '#0f172a', // ink
  muted: '#64748b',
  border: '#e2e8f0',
  surface: '#f8fafc',
} as const;

const styles = StyleSheet.create({
  page: {
    paddingHorizontal: 32,
    paddingVertical: 28,
    fontFamily: 'Helvetica',
    color: TOKEN.text,
    fontSize: 9,
  },
  title: { fontFamily: 'Helvetica-Bold', fontSize: 15, color: TOKEN.text },
  subhead: { marginTop: 4, fontSize: 9, color: TOKEN.muted },
  kpiGrid: {
    marginTop: 18,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  kpiBox: {
    width: '48%',
    borderWidth: 1,
    borderColor: TOKEN.border,
    borderRadius: 6,
    backgroundColor: TOKEN.surface,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  kpiLabel: {
    fontSize: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: TOKEN.muted,
  },
  kpiValue: { fontFamily: 'Courier-Bold', fontSize: 17, marginTop: 5 },
  tableHeading: { fontFamily: 'Helvetica-Bold', fontSize: 11, marginTop: 22, marginBottom: 8 },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: TOKEN.border,
    paddingVertical: 6,
  },
  headRow: { borderBottomWidth: 1.5, borderBottomColor: TOKEN.text, paddingVertical: 6 },
  th: { fontFamily: 'Helvetica-Bold', fontSize: 8, color: TOKEN.muted },
  td: { fontFamily: 'Courier', fontSize: 8, color: TOKEN.text },
  tdName: { fontFamily: 'Helvetica', fontSize: 8, color: TOKEN.text },
  footer: {
    position: 'absolute',
    bottom: 20,
    left: 32,
    right: 32,
    fontSize: 7,
    color: TOKEN.muted,
    textAlign: 'center',
  },
});

// Column layout: name is widest; the rest share the remaining width evenly.
const COLS = [
  { key: 'name', label: 'Initiative', width: '20%', align: 'left' as const },
  { key: 'monthly', label: 'Monthly Cost', width: '12%', align: 'right' as const },
  { key: 'annual', label: 'Annual Run Rate', width: '13%', align: 'right' as const },
  { key: 'budget', label: 'Budget %', width: '9%', align: 'right' as const },
  { key: 'status', label: 'Status', width: '13%', align: 'left' as const },
  { key: 'efficiency', label: 'Cost Efficiency', width: '12%', align: 'right' as const },
  { key: 'savings', label: 'Savings Opp.', width: '11%', align: 'right' as const },
  { key: 'updated', label: 'Last Updated', width: '10%', align: 'right' as const },
];

function KpiBox({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.kpiBox}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={[styles.kpiValue, { color: color ?? TOKEN.text }]}>{value}</Text>
    </View>
  );
}

function Cell({
  width,
  align,
  mono,
  color,
  children,
}: {
  width: string;
  align: 'left' | 'right';
  mono: boolean;
  color?: string;
  children: string;
}) {
  return (
    <Text
      style={[mono ? styles.td : styles.tdName, { width, textAlign: align, color: color ?? TOKEN.text }]}
    >
      {children}
    </Text>
  );
}

function ReportDocument({ model }: { model: ReportModel }) {
  const { summary } = model;
  return (
    <Document title="Ratio — Initiative Cost Report">
      <Page size="A4" orientation="landscape" style={styles.page}>
        <Text style={styles.title}>Ratio — Initiative Cost Report</Text>
        <Text style={styles.subhead}>
          {model.periodLabel}  ·  Generated: {model.generatedAt} UTC
        </Text>

        <View style={styles.kpiGrid}>
          <KpiBox label="Total Cloud Spend" value={`${formatUSD(summary.totalMonthlySpend)}/mo`} color={TOKEN.cost} />
          <KpiBox label="Projected Savings" value={formatUSD(summary.projectedSavings)} color={TOKEN.value} />
          <KpiBox label="Initiatives Active" value={String(summary.initiativesActive)} />
          <KpiBox
            label="Pending Approval"
            value={String(summary.pendingApproval)}
            color={summary.pendingApproval > 0 ? TOKEN.gate : TOKEN.text}
          />
        </View>

        <Text style={styles.tableHeading}>Initiative Portfolio</Text>
        <View style={styles.headRow}>
          <View style={{ flexDirection: 'row' }}>
            {COLS.map((c) => (
              <Text key={c.key} style={[styles.th, { width: c.width, textAlign: c.align }]}>
                {c.label}
              </Text>
            ))}
          </View>
        </View>

        {model.rows.map((r: ReportRow, i: number) => (
          <View key={i} style={styles.row}>
            <Cell width={COLS[0].width} align="left" mono={false}>{r.name}</Cell>
            <Cell width={COLS[1].width} align="right" mono color={TOKEN.cost}>{formatUSD(r.monthlyCost)}</Cell>
            <Cell width={COLS[2].width} align="right" mono>{formatUSD(r.annualRunRate)}</Cell>
            <Cell width={COLS[3].width} align="right" mono>{`${r.budgetConsumedPct}%`}</Cell>
            <Cell width={COLS[4].width} align="left" mono={false}>{r.status}</Cell>
            <Cell width={COLS[5].width} align="right" mono color={TOKEN.value}>{formatRatio(r.costEfficiency)}</Cell>
            <Cell width={COLS[6].width} align="right" mono color={r.savingsOpportunity > 0 ? TOKEN.value : TOKEN.text}>
              {r.savingsOpportunity > 0 ? formatUSD(r.savingsOpportunity) : '—'}
            </Cell>
            <Cell width={COLS[7].width} align="right" mono>{r.lastUpdated}</Cell>
          </View>
        ))}

        <Text style={styles.footer} fixed>
          Generated from Ratio Mission Control · Confidential · {model.generatedAt}
        </Text>
      </Page>
      {model.outcomeReports && <Page size="A4" orientation="landscape" style={styles.page}>
        <Text style={styles.title}>Initiative Outcome Accountability</Text><Text style={styles.subhead}>{model.periodLabel} · simulated evidence · benefit / full cost</Text>
        <Text style={{ marginTop: 12, marginBottom: 12 }}>Measured returns require independently reviewed performance, financial evidence and complete costs. Quality and risk remain nonfinancial; assumed and projected benefits are excluded.</Text>
        {model.outcomeReports.map(({ name, record, result, decisionStale }) => <View key={record.workloadId} wrap={false} style={{ borderBottomWidth: 1, borderColor: TOKEN.border, paddingVertical: 8 }}>
          <Text style={{ fontFamily: 'Helvetica-Bold' }}>{name} · {record.owner}</Text>
          <Text style={{ marginTop: 3 }}>{record.metric}: {record.baseline.value} → {record.observation.value} {record.unit} · target {record.target} · evidence {record.planRecordedBy ?? 'unattributed'} / {record.planVerified?.by ?? 'unverified'}</Text>
          <Text style={{ marginTop: 3 }}>Full cost: {result.totalCostCents === null ? 'Incomplete' : formatUSD(result.totalCostCents / 100)} · benefit: {formatUSD(result.measuredBenefitCents / 100)} · return: {result.measuredRatio === null ? 'Not established' : formatRatio(result.measuredRatio)} · reviews value {record.measures.filter(m => m.status === 'measured' && m.verified).length}/{record.measures.filter(m => m.status === 'measured').length}, cost {COST_CATEGORIES.filter(k => record.costs[k].status === 'measured' && record.costs[k].verified).length}/{COST_CATEGORIES.filter(k => record.costs[k].status === 'measured').length} · decision {decisionStale ? 'renew' : result.recommendation}</Text>
          <Text style={{ marginTop: 3 }}>Thresholds · stop below {record.thresholds.stopBelow}× · continue at {record.thresholds.continueAt}× · expand at {record.thresholds.expandAt}× with performance target met</Text>
        </View>)}
        <Text style={styles.footer} fixed>Generated from saved outcome evidence · {model.generatedAt}</Text>
      </Page>}
    </Document>
  );
}

export function renderReportPdf(now: Date = new Date(), model: ReportModel = buildReportModel(now)): Promise<Buffer> {
  return renderToBuffer(<ReportDocument model={model} />);
}
