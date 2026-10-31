// POST /api/auth/login — R2 engagement sign-in (engagement mode only; 404 otherwise); see src/engagement/auth/routes.ts.
import { createLoginRoute } from '@/engagement/auth/routes';

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };
export default createLoginRoute();
