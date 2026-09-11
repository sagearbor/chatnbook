import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { sendNotification, extractContact } from './notify.js';
import { getWellKnownDocument } from '../../discovery/well_known.js';
import type { AppointmentRecord, AppointmentsRepository } from './repositories/appointments-repo.js';
import { InMemoryAppointmentsRepository } from './repositories/memory-appointments-repo.js';
import { PgAppointmentsRepository } from './repositories/pg-appointments-repo.js';
import type { OAuthTokensRepository } from './repositories/oauth-tokens-repo.js';
import { InMemoryOAuthTokensRepository } from './repositories/memory-oauth-tokens-repo.js';
import { PgOAuthTokensRepository } from './repositories/pg-oauth-tokens-repo.js';
import type { ServiceRecord, ServicesRepository } from './repositories/services-repo.js';
import { InMemoryServicesRepository } from './repositories/memory-services-repo.js';
import { PgServicesRepository } from './repositories/pg-services-repo.js';
import { createOAuthRouter, getValidAccessToken, CalendarNotConnectedError } from './oauth/routes.js';
import { isOAuthProvider } from './oauth/providers.js';
import type { CalendarConnector } from './connectors/calendar-connector.js';
import { ConnectorError } from './connectors/calendar-connector.js';
import { PythonCalendarConnector } from './connectors/python-calendar-connector.js';

export const app = express();
app.use(cors());
app.use(express.json());

// Appointments persist to Postgres whenever DATABASE_URL is configured
// (the normal case -- see infra/docker-compose.dev.yml and
// migrations/001_create_appointments.sql). The in-memory repository is
// kept as a test double for fast unit tests that don't need Docker.
const appointmentsRepo: AppointmentsRepository = process.env.DATABASE_URL
  ? new PgAppointmentsRepository(process.env.DATABASE_URL)
  : new InMemoryAppointmentsRepository();

// Same pattern for OAuth calendar tokens (migrations/002_create_oauth_tokens.sql).
const oauthTokensRepo: OAuthTokensRepository = process.env.DATABASE_URL
  ? new PgOAuthTokensRepository(process.env.DATABASE_URL)
  : new InMemoryOAuthTokensRepository();

// Same pattern for services (migrations/003_create_services.sql). Backs
// GET /v1/services and lets GET /v1/availability honour a serviceId.
const servicesRepo: ServicesRepository = process.env.DATABASE_URL
  ? new PgServicesRepository(process.env.DATABASE_URL)
  : new InMemoryServicesRepository();

app.use(createOAuthRouter(oauthTokensRepo));

// Calls the Python connectors (packages/connectors-py) for calendar
// availability + event creation. Production default shells out to python;
// API tests inject a fake via setCalendarConnectorForTest so they never
// spawn a subprocess. The one real integration test
// (test/appointments-connector-integration.test.js) intentionally leaves
// this as the real PythonCalendarConnector.
let calendarConnector: CalendarConnector = new PythonCalendarConnector();

/** Test-only: swaps the calendar connector implementation. */
export function setCalendarConnectorForTest(connector: CalendarConnector) {
  calendarConnector = connector;
}

/** Test-only: direct access to the OAuth tokens repository, so tests can
 * inspect what's actually stored (e.g. assert it's encrypted, not
 * plaintext) or seed an expired token to exercise refresh handling. */
export function getOAuthTokensRepoForTest(): OAuthTokensRepository {
  return oauthTokensRepo;
}

/** Test/seed-only: direct access to the services repository. There's no
 * admin HTTP endpoint for creating services yet (out of scope -- see
 * docs/REALITY-CHECK.md), so tests seed rows directly through this. */
export function getServicesRepoForTest(): ServicesRepository {
  return servicesRepo;
}

function toAppointmentResponse(record: AppointmentRecord) {
  return {
    id: record.id,
    status: record.status,
    startTime: record.startTime,
    endTime: record.endTime ?? undefined,
    provider_event_id: record.providerEventId ?? undefined,
  };
}

function toServiceResponse(record: ServiceRecord) {
  return {
    id: record.id,
    accountId: record.accountId,
    name: record.name,
    durationMinutes: record.durationMinutes,
    bufferMinutes: record.bufferMinutes,
  };
}

// Basic IP-based rate limiter: 60 req/min
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
const hits = new Map<string, { count: number; first: number }>();

function rateLimit(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const now = Date.now();
  const ip = req.ip || 'unknown';
  const entry = hits.get(ip);
  if (!entry || now - entry.first > RATE_LIMIT_WINDOW_MS) {
    hits.set(ip, { count: 1, first: now });
    return next();
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }
  entry.count++;
  next();
}
app.use(rateLimit);

const AGENT_HMAC_SECRET = process.env.AGENT_HMAC_SECRET || '';

/** Test helper: clears persisted appointment state (Postgres or in-memory). */
export async function resetIdempotency() {
  await appointmentsRepo.reset();
}

/** Test helper: clears persisted OAuth token state (Postgres or in-memory). */
export async function resetOAuthTokens() {
  await oauthTokensRepo.reset();
}

/** Test helper: clears persisted services state (Postgres or in-memory). */
export async function resetServices() {
  await servicesRepo.reset();
}

/** Test helper: closes the underlying DB pool / connections. */
export async function closeRepositories() {
  await appointmentsRepo.close();
  await oauthTokensRepo.close();
  await servicesRepo.close();
}

function verifyHmac(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!AGENT_HMAC_SECRET) {
    return res.status(500).json({ error: 'HMAC secret not configured' });
  }
  const sig = req.header('X-Signature');
  if (!sig) {
    return res.status(401).json({ error: 'Missing signature' });
  }
  const body = JSON.stringify(req.body || '');
  const digest = crypto.createHmac('sha256', AGENT_HMAC_SECRET).update(body).digest('base64');
  if (digest !== sig) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  next();
}

app.get('/.well-known/ai-actions.json', (_req, res) => {
  res.json(getWellKnownDocument());
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// Serve OpenAPI
app.get(['/openapi.json', '/.well-known/openapi.json'], (_req, res) => {
  const p = path.join(__dirname, '../openapi/openapi.json');
  const spec = fs.readFileSync(p, 'utf-8');
  res.type('application/json').send(spec);
});

// Real services, backed by Postgres/in-memory (migrations/003_create_services.sql).
// accountId is required -- services are account-scoped data, and there's
// no admin auth in front of this endpoint yet, so we don't want a bare
// GET /v1/services to dump every account's services.
app.get('/v1/services', async (req, res) => {
  const { accountId } = req.query;
  if (!accountId || typeof accountId !== 'string') {
    return res.status(400).json({ error: 'accountId query parameter is required' });
  }
  try {
    const services = await servicesRepo.listByAccount(accountId);
    res.json({ services: services.map(toServiceResponse) });
  } catch (err) {
    console.error('failed to list services', err);
    res.status(500).json({ error: 'Failed to list services' });
  }
});

// Real calendar availability when accountId/provider/calendarId are given
// (queries the connected calendar via the Python connectors and computes
// free slots); falls back to the historical `{ slots: [] }` stub when
// they're not, so existing callers (e.g. packages/adapters/mcp, which
// today only sends serviceId/start/end/tz) keep working unchanged.
app.get('/v1/availability', async (req, res) => {
  const { accountId, provider, calendarId, start, end, serviceId } = req.query;
  let slotMinutes = Number(req.query.slotMinutes) || 30;
  if (!accountId || !provider || !calendarId || !start || !end) {
    return res.json({ slots: [] });
  }
  if (typeof provider !== 'string' || !isOAuthProvider(provider)) {
    return res.status(400).json({ error: `unsupported provider: ${provider}` });
  }
  if (typeof start !== 'string' || typeof end !== 'string' || typeof calendarId !== 'string') {
    return res.status(400).json({ error: 'accountId, calendarId, start, and end must be strings' });
  }
  // Honour serviceId when given: the service's own duration + buffer
  // determines the slot length, instead of trusting an arbitrary
  // client-supplied slotMinutes to match the service being booked.
  if (serviceId !== undefined) {
    if (typeof serviceId !== 'string') {
      return res.status(400).json({ error: 'serviceId must be a string' });
    }
    const service = await servicesRepo.getById(serviceId);
    if (!service) {
      return res.status(404).json({ error: `unknown serviceId: ${serviceId}` });
    }
    if (service.accountId !== accountId) {
      return res.status(400).json({ error: 'serviceId does not belong to accountId' });
    }
    slotMinutes = service.durationMinutes + service.bufferMinutes;
  }
  try {
    const token = await getValidAccessToken(oauthTokensRepo, String(accountId), provider);
    const busy = await calendarConnector.getBusy({ provider, token, calendarId, start, end });
    const slots = await calendarConnector.computeAvailability({ start, end, busy, slotMinutes });
    res.json({ slots });
  } catch (err) {
    if (err instanceof CalendarNotConnectedError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof ConnectorError) {
      console.error('calendar connector error computing availability', err);
      return res.status(502).json({ error: 'Failed to reach calendar provider' });
    }
    console.error('failed to compute availability', err);
    res.status(500).json({ error: 'Failed to compute availability' });
  }
});

app.post('/v1/appointments', verifyHmac, async (req, res) => {
  const key = req.header('Idempotency-Key');
  if (!key) {
    return res.status(400).json({ error: 'Idempotency-Key required' });
  }
  const { accountId, serviceId, startTime, customer, provider, calendarId, durationMinutes } =
    req.body || {};
  if (!accountId || !serviceId || !startTime || !customer?.name || !customer?.email) {
    return res.status(400).json({
      error: 'accountId, serviceId, startTime, and customer.name/customer.email are required',
    });
  }
  if (provider !== undefined && !isOAuthProvider(provider)) {
    return res.status(400).json({ error: `unsupported provider: ${provider}` });
  }
  if (provider && !calendarId) {
    return res.status(400).json({ error: 'calendarId is required when provider is set' });
  }

  try {
    // Idempotency replay check happens *before* any calendar work, so a
    // retried request (after a prior request with this key already fully
    // completed) never creates a second real calendar event.
    const existing = await appointmentsRepo.getByIdempotencyKey(key);
    if (existing) {
      return res.status(200).json(toAppointmentResponse(existing));
    }

    // DB-level guard against two concurrent *first* requests with the same
    // key (see migrations/005_create_idempotency_claims.sql): only the
    // request that wins this atomic claim goes on to do the (expensive,
    // side-effecting) calendar work below. A request that loses the race
    // polls for the winner's row instead of duplicating it -- previously
    // both requests could reach the calendar work and each create a real
    // (duplicate) calendar event, since the getByIdempotencyKey check above
    // is not itself atomic across concurrent requests.
    const claimed = await appointmentsRepo.tryClaim(key);
    if (!claimed) {
      const winnerRecord = await waitForClaimedAppointment(key);
      if (winnerRecord) {
        return res.status(200).json(toAppointmentResponse(winnerRecord));
      }
      return res.status(409).json({
        error: 'a request with this Idempotency-Key is already being processed; please retry',
      });
    }

    // From here on, this request owns processing `key` -- release the
    // claim on every exit path (success or failure) so a genuine retry
    // (not a concurrent racer, but the same client trying again after a
    // failure) can attempt the booking again with the same key.
    try {
      return await handleCreateAppointment(req, res, key, {
        accountId,
        serviceId,
        startTime,
        customer,
        provider,
        calendarId,
        durationMinutes,
      });
    } finally {
      await appointmentsRepo.releaseClaim(key);
    }
  } catch (err) {
    console.error('failed to create appointment', err);
    res.status(500).json({ error: 'Failed to create appointment' });
  }
});

/** Polls for the appointment row a concurrent winner is creating (see the
 * tryClaim guard above), so a losing request returns the same result
 * instead of duplicating calendar work. Short poll: the winner is usually
 * done within one or two calendar round-trips. */
async function waitForClaimedAppointment(
  key: string,
  timeoutMs = 3000,
  intervalMs = 25
): Promise<AppointmentRecord | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await appointmentsRepo.getByIdempotencyKey(key);
    if (record) return record;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** The actual booking logic, run only by the request that won the
 * idempotency-key claim above. Sends the response itself (so the caller
 * can `return` its result directly) and always returns after responding. */
async function handleCreateAppointment(
  req: express.Request,
  res: express.Response,
  key: string,
  body: {
    accountId: string;
    serviceId: string;
    startTime: string;
    customer: { name: string; email: string; phone?: string };
    provider?: string;
    calendarId?: string;
    durationMinutes?: number;
  }
) {
  const { accountId, serviceId, startTime, customer, provider, calendarId, durationMinutes } = body;
  try {
    let providerEventId: string | undefined;
    if (provider) {
      // Re-validated here (already checked once in the outer route
      // handler before the idempotency claim) so TypeScript narrows
      // `provider`/`calendarId` to the non-optional types the connector
      // calls below require.
      if (!isOAuthProvider(provider)) {
        return res.status(400).json({ error: `unsupported provider: ${provider}` });
      }
      if (!calendarId) {
        return res.status(400).json({ error: 'calendarId is required when provider is set' });
      }
      let token: string;
      try {
        token = await getValidAccessToken(oauthTokensRepo, accountId, provider);
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
      }
      const duration = Number(durationMinutes) > 0 ? Number(durationMinutes) : 30;
      const startDate = new Date(startTime);
      if (Number.isNaN(startDate.getTime())) {
        return res.status(400).json({ error: 'startTime must be a valid ISO-8601 date-time' });
      }
      const endDate = new Date(startDate.getTime() + duration * 60_000);
      const startIso = startDate.toISOString();
      const endIso = endDate.toISOString();

      let busy;
      try {
        busy = await calendarConnector.getBusy({
          provider,
          token,
          calendarId,
          start: startIso,
          end: endIso,
        });
      } catch (err) {
        console.error('calendar connector error checking availability', err);
        return res.status(502).json({ error: 'Failed to reach calendar provider' });
      }
      const conflict = busy.some(
        (b) => new Date(b.start).getTime() < endDate.getTime() && new Date(b.end).getTime() > startDate.getTime()
      );
      if (conflict) {
        return res.status(409).json({ error: 'requested time is not available' });
      }

      try {
        const createdEvent = await calendarConnector.createEvent({
          provider,
          token,
          calendarId,
          start: startIso,
          end: endIso,
          summary: `${serviceId} - ${customer.name}`,
        });
        providerEventId = createdEvent.eventId;
      } catch (err) {
        console.error('calendar connector error creating event', err);
        return res.status(502).json({ error: 'Failed to create calendar event' });
      }
    }

    const { record, created } = await appointmentsRepo.createIdempotent({
      idempotencyKey: key,
      accountId,
      serviceId,
      startTime,
      customer,
      notes: req.body?.notes,
      source: req.body?.source,
      metadata: req.body?.metadata,
      providerEventId,
      provider: provider ?? undefined,
      calendarId: calendarId ?? undefined,
    });
    if (created) {
      sendNotification({
        to: extractContact(req),
        type: 'appointment_requested',
        payload: toAppointmentResponse(record),
      });
    }
    res.status(created ? 201 : 200).json(toAppointmentResponse(record));
  } catch (err) {
    console.error('failed to create appointment', err);
    res.status(500).json({ error: 'Failed to create appointment' });
  }
}

app.post('/v1/appointments/:id/cancel', verifyHmac, async (req, res) => {
  try {
    const existing = await appointmentsRepo.getById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    // Delete the real calendar event when one was created for this
    // appointment. Tolerates the connector reporting the event as already
    // gone (see connectors-py's google.py/microsoft.py delete_event,
    // called via PythonCalendarConnector.deleteEvent) -- that resolves
    // normally rather than throwing, so cancelling twice (or cancelling an
    // event someone already deleted directly on the provider) still
    // succeeds here.
    if (existing.providerEventId && existing.provider && existing.calendarId) {
      if (!isOAuthProvider(existing.provider)) {
        console.error(
          `appointment ${existing.id} has unsupported provider ${existing.provider}; skipping calendar delete`
        );
      } else {
        try {
          const token = await getValidAccessToken(oauthTokensRepo, existing.accountId, existing.provider);
          await calendarConnector.deleteEvent({
            provider: existing.provider,
            token,
            calendarId: existing.calendarId,
            eventId: existing.providerEventId,
          });
        } catch (err) {
          if (err instanceof CalendarNotConnectedError) {
            // Calendar was disconnected after booking -- nothing we can do
            // to remove the remote event from here; still cancel locally
            // rather than blocking the customer's cancellation on it.
            console.error('cannot delete calendar event: calendar no longer connected', err);
          } else {
            console.error('calendar connector error deleting event', err);
            return res.status(502).json({ error: 'Failed to delete calendar event' });
          }
        }
      }
    }

    const record = await appointmentsRepo.cancel(req.params.id);
    if (!record) {
      return res.status(404).json({ error: 'Appointment not found' });
    }
    sendNotification({
      to: extractContact(req),
      type: 'appointment_canceled',
      payload: toAppointmentResponse(record),
    });
    res.json(toAppointmentResponse(record));
  } catch (err) {
    console.error('failed to cancel appointment', err);
    res.status(500).json({ error: 'Failed to cancel appointment' });
  }
});

app.post('/v1/appointments/:id/reschedule', verifyHmac, async (req, res) => {
  const newStartTime = req.body?.newStartTime;
  if (!newStartTime) {
    return res.status(400).json({ error: 'newStartTime is required' });
  }
  try {
    const record = await appointmentsRepo.reschedule(req.params.id, newStartTime);
    if (!record) {
      return res.status(404).json({ error: 'Appointment not found' });
    }
    sendNotification({
      to: extractContact(req),
      type: 'appointment_rescheduled',
      payload: toAppointmentResponse(record),
    });
    res.json(toAppointmentResponse(record));
  } catch (err) {
    console.error('failed to reschedule appointment', err);
    res.status(500).json({ error: 'Failed to reschedule appointment' });
  }
});

if (process.env.NODE_ENV !== 'test') {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`API listening on :${port}`));
}
