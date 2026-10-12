const { buildCsp } = require('./csp.config.js');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // A test-owned build directory lets the browser suite run beside a developer's server.
  ...(process.env.RATIO_TEST_NEXT_DIR ? { distDir: process.env.RATIO_TEST_NEXT_DIR } : {}),
  // Content-Security-Policy on every response (policy and rationale: csp.config.js).
  // Development and Vercel preview builds get the small, documented relaxations there.
  async headers() {
    const policy = buildCsp({ dev: process.env.NODE_ENV === 'development', preview: process.env.VERCEL_ENV === 'preview' });
    // RATIO_CSP_MODE=report-only is the rollout lever: browsers report but do not block.
    const key = process.env.RATIO_CSP_MODE === 'report-only' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
    return [{ source: '/:path*', headers: [{ key, value: policy }] }];
  },
};

module.exports = nextConfig;
