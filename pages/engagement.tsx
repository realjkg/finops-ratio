// /engagement: the engagement report page (R2), engagement mode only (404 otherwise), behind the named-user session.
// Server: src/engagement/reportPage.ts. Browser: src/engagement/EngagementReportPage.tsx.
import type { GetServerSideProps } from 'next';
import { EngagementReportPage } from '@/engagement/EngagementReportPage';
import { reportPageProps, type ReportPageProps } from '@/engagement/reportPage';
import { ENGAGEMENT_PAGE_MARK } from '@/lib/demoMode';

// The mark tells the browser this page was served in engagement mode, so no demo indicator renders.
export const getServerSideProps: GetServerSideProps<ReportPageProps & { [ENGAGEMENT_PAGE_MARK]: 'engagement' }> = async ({ req, res }) => {
  const r = reportPageProps(req as never, process.env);
  if (!r) return { notFound: true };
  res.statusCode = r.status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Cookie');
  return { props: { ...r.props, [ENGAGEMENT_PAGE_MARK]: 'engagement' as const } };
};

export default EngagementReportPage;
