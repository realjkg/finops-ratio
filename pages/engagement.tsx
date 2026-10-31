// /engagement: the engagement report page (R2), engagement mode only (404 otherwise), behind the named-user session.
// Server: src/engagement/reportPage.ts. Browser: src/engagement/EngagementReportPage.tsx.
import type { GetServerSideProps } from 'next';
import { EngagementReportPage } from '@/engagement/EngagementReportPage';
import { reportPageProps, type ReportPageProps } from '@/engagement/reportPage';

export const getServerSideProps: GetServerSideProps<ReportPageProps> = async ({ req, res }) => {
  const r = reportPageProps(req as never, process.env);
  if (!r) return { notFound: true };
  res.statusCode = r.status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Cookie');
  return { props: r.props };
};

export default EngagementReportPage;
