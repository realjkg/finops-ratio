// API gateway public surface (Wave3b). Compose any /api route with withGateway.
export { withGateway, sendError } from './withGateway';
export type {
  GatewayContext,
  GatewayHandler,
  GatewayOptions,
  GatewayValidation,
  GatewayLogEntry,
  GatewayErrorBody,
} from './withGateway';
export {
  SlidingWindowRateLimiter,
  STANDARD_TIER_LIMIT,
  WINDOW_MS,
} from './rateLimit';
export type { RateLimitResult } from './rateLimit';
export {
  resolveGatewayAuth,
  checkAuth,
  extractBearer,
  tenantId,
  tokensMatch,
} from './auth';
export type { GatewayAuthConfig, AuthOutcome } from './auth';

