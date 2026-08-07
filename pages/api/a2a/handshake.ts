// Deprecated alias for POST /api/v1/a2a/handshake.
//
// The FinIO routes originally shipped outside the /v1/ prefix that the repo's
// API-First rule requires (.obvious/obvious.md). The versioned route is
// canonical; this alias keeps any peer already pointed here working. New callers
// should use /api/v1/a2a/handshake.
export { default } from '../v1/a2a/handshake';
