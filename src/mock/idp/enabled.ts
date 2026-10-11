// The one mock IdP gate (card A2), shared by the issuer, the verifier, card
// B1's MockIdpVerifier and card B7's login and mock-control routes.
//
// True only when RATIO_MOCK_IDP is exactly '1' AND the raw RATIO_ENV is
// exactly 'development' or 'test'. It is an allow-list of exact strings: no
// trimming and no case folding, so unset, empty, 'staging', 'production',
// 'prod', 'Production' and padded values are all disabled. The Node build
// mode plays no part. Only own properties count, so a polluted prototype
// cannot switch the gate on. Same shape as simulationEnabled() in
// src/simulation/server/enabled.ts.

export type MockIdpEnv = Readonly<Record<string, string | undefined>>;

const ALLOWED_RATIO_ENVS: readonly string[] = ['development', 'test'];

function own(env: MockIdpEnv, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(env, key) ? env[key] : undefined;
}

export function mockIdpEnabled(env: MockIdpEnv = process.env): boolean {
  const flag = own(env, 'RATIO_MOCK_IDP');
  const ratioEnv = own(env, 'RATIO_ENV');
  return flag === '1' && typeof ratioEnv === 'string' && ALLOWED_RATIO_ENVS.includes(ratioEnv);
}
