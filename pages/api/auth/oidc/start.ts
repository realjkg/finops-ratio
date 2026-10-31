// GET /api/auth/oidc/start — R2 OIDC sign-in (engagement mode only; 404 otherwise); see src/engagement/auth/oidc.ts.
import { createOidcStartRoute } from '@/engagement/auth/oidc';

export default createOidcStartRoute();
