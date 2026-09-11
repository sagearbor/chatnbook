// Framework-agnostic discovery payload. Deliberately has no dependency on
// express (or any HTTP framework) so this package doesn't need express as
// an installed dependency just to be type-checked when it's pulled into
// another package's build via a relative import (see docs/REALITY-CHECK.md
// for the `pnpm -r build` failure this used to cause).

export interface WellKnownAction {
  name: string;
  method: string;
  url: string;
  openapi: string;
  /** Whether an agent must HMAC-sign the request (X-Signature). Browser
   * clients can't hold a shared secret, which is why the public booking
   * action exists alongside the signed one. */
  auth: 'hmac' | 'none';
}

export interface WellKnownDocument {
  actions: WellKnownAction[];
}

/**
 * @param baseUrl Absolute origin the API is reachable at, e.g.
 *   `https://chatnbook-api-xxxx.run.app`. Callers pass PUBLIC_API_BASE when
 *   it's set, otherwise the base derived from the incoming request, so the
 *   published document never advertises a hard-coded example.com/localhost
 *   host. Passing nothing keeps the historical site-relative URLs.
 */
export function getWellKnownDocument(baseUrl = ''): WellKnownDocument {
  const base = baseUrl.replace(/\/+$/, '');
  const url = (p: string) => `${base}${p}`;
  const openapi = url('/openapi.json');
  return {
    actions: [
      {
        name: 'listAvailability',
        method: 'GET',
        url: url('/v1/availability'),
        openapi,
        auth: 'none',
      },
      {
        name: 'createAppointment',
        method: 'POST',
        url: url('/v1/appointments'),
        openapi,
        auth: 'hmac',
      },
      {
        name: 'createPublicAppointment',
        method: 'POST',
        url: url('/v1/public/appointments'),
        openapi,
        auth: 'none',
      },
    ],
  };
}
