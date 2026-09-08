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
}

export interface WellKnownDocument {
  actions: WellKnownAction[];
}

export function getWellKnownDocument(): WellKnownDocument {
  return {
    actions: [
      {
        name: 'createAppointment',
        method: 'POST',
        url: '/v1/appointments',
        openapi: '/openapi.json',
      },
    ],
  };
}
