// Next 16 proxy (formerly middleware). R2 slice D: in engagement mode
// (RATIO_MODE=engagement) only the engagement surface is served
// (src/engagement/allowlist.ts); `/` redirects to the report page and
// everything else is a no-store 404, including the demo pages and the seed,
// simulation and shared-token gateway routes. Outside engagement mode nothing
// changes. Any other non-empty RATIO_MODE fails closed (404 everywhere; the
// server also refuses to start). Each allowed route still does its own
// authentication and authorization.
import { NextResponse, type NextRequest } from 'next/server';
import { engagementPathAllowed } from './src/engagement/allowlist';

const notFound = () => new NextResponse('Not found', { status: 404, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } });

export function proxy(request: NextRequest): NextResponse {
  const mode = process.env.RATIO_MODE;
  if (mode === undefined || mode === '') return NextResponse.next();
  if (mode !== 'engagement') return notFound();
  const { pathname } = request.nextUrl;
  if (pathname === '/') return NextResponse.redirect(new URL('/engagement', request.url));
  return engagementPathAllowed(pathname) ? NextResponse.next() : notFound();
}
