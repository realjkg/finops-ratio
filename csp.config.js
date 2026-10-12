// Content-Security-Policy for the app (consumed by next.config.js).
//
// Plain CommonJS because next.config.js cannot import TypeScript. Nonces are not
// an option here: the Pages Router prerenders most routes at build time, when no
// request exists to carry one. The one inline script (the theme pre-paint script
// in pages/_document.tsx) is therefore allowed by hash. PREPAINT_HASH is the
// sha256 of PREPAINT_SCRIPT (src/theme/user.ts); src/security/csp.test.ts fails
// if the two drift, so editing the script means updating this constant.

// What the policy deliberately does and does not do:
//  - script-src: 'self' plus that one hash. No 'unsafe-inline'. Next's Pages Router
//    emits no other executable inline script in production (__NEXT_DATA__ is a
//    type="application/json" block, which CSP does not govern); verified in
//    Chromium by tests/simulation/csp.spec.ts on a production build.
//  - style-src-attr 'unsafe-inline' is the one inline allowance (see below).
//  - No upgrade-insecure-requests: it would break http://127.0.0.1 local runs and
//    HTTPS is the host's job (HSTS at the edge).
//  - No report-uri/report-to: the app has no collection endpoint, and tests run
//    without network egress. Violations show in the browser console.
// Rollout lever (BUILD time): next.config.js headers() is evaluated by `next build`
// and frozen into routes-manifest.json; `next start` never re-reads the env, so
// changing RATIO_CSP_MODE needs a rebuild. Build with RATIO_CSP_MODE=report-only to
// send the same policy as Content-Security-Policy-Report-Only; rebuild without it
// to enforce. The same holds for VERCEL_ENV and NODE_ENV. Changing the pre-paint
// script requires a matching change to PREPAINT_HASH (other directives do not).
const PREPAINT_HASH = "'sha256-j2+qMXrX/9a2DQN0Mdq5cwMIrCT8DZJHuAfbANm+YVA='";

// Vercel's preview toolbar (comments, feedback) injects its own script, frame and
// websocket on preview deployments only. Production never gets these.
const VERCEL_LIVE = {
  script: ['https://vercel.live'],
  style: ['https://vercel.live'],
  connect: ['https://vercel.live', 'wss://ws-us3.pusher.com'],
  frame: ['https://vercel.live'],
  img: ['https://vercel.live', 'https://vercel.com'],
  font: ['https://vercel.live', 'https://assets.vercel.com'],
};

/** @param {{ dev: boolean, preview: boolean }} env */
function buildCsp({ dev, preview }) {
  const extra = (key) => (preview ? VERCEL_LIVE[key] : []);
  const directives = {
    'default-src': ["'self'"],
    // Development needs eval for React's debugging features; production does not.
    'script-src': ["'self'", PREPAINT_HASH, ...(dev ? ["'unsafe-eval'"] : []), ...extra('script')],
    // Development injects CSS as <style> elements (hot reload); production links files.
    'style-src': ["'self'", ...(dev ? ["'unsafe-inline'"] : []), ...extra('style')],
    // Server-rendered style="..." attributes (43 components use them) are blocked
    // by style-src alone. This directive covers attributes only: <style> elements
    // stay restricted, and attribute styles cannot run script or load non-self URLs
    // (img-src and font-src still apply). Residual risk: injected markup could
    // restyle the page (UI redress); it cannot execute code.
    'style-src-attr': ["'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', ...extra('img')],
    'font-src': ["'self'", ...extra('font')],
    'connect-src': ["'self'", ...(dev ? ['ws:'] : []), ...extra('connect')],
    'frame-src': extra('frame').length ? extra('frame') : ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives).map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

module.exports = { PREPAINT_HASH, buildCsp };
