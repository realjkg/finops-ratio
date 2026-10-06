import { withBasePath } from '@/lib/basePath';
export class SimulationHttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function simulationRequest<T>(path: string, body?: unknown, csrf?: string, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(withBasePath(`/api/v1/simulation/${path}`), {
    signal: AbortSignal.timeout(30_000),
    method, credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-Ratio-CSRF': csrf } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new SimulationHttpError(response.status, result.error ?? 'Request failed.');
  return result as T;
}
