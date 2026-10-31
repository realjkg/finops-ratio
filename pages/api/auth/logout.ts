// POST /api/auth/logout — R2 engagement sign-in (engagement mode only; 404 otherwise); see src/engagement/auth/routes.ts.
import { createLogoutRoute } from '@/engagement/auth/routes';

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };
export default createLogoutRoute();
