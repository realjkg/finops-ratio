/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // A test-owned build directory lets the browser suite run beside a developer's server.
  ...(process.env.RATIO_TEST_NEXT_DIR ? { distDir: process.env.RATIO_TEST_NEXT_DIR } : {}),
};

module.exports = nextConfig;
