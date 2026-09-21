// Browser-side URLs that Next.js cannot automatically rewrite for a Webflow Cloud mount path.
// Next.js <Link>, useRouter(), redirects, and next/image already receive the generated basePath.
// Manual fetch() calls do not, so Webflow's environment mount path is exposed separately.

function configuredBasePath(): string {
  const raw = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  if (!raw || raw === '/') return '';
  return `/${raw.replace(/^\/+|\/+$/g, '')}`;
}

export function withBasePath(path: string): string {
  if (!path.startsWith('/')) return path;
  return `${configuredBasePath()}${path}`;
}
