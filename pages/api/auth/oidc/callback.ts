// GET /api/auth/oidc/callback — R2 OIDC sign-in (engagement mode only; 404 otherwise); see src/engagement/auth/oidc.ts.
import { createOidcCallbackRoute } from '@/engagement/auth/oidc';

export default createOidcCallbackRoute();
