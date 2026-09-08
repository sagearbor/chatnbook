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

function toAppointmentResponse(record: AppointmentRecord) {
  return {
    id: record.id,
    status: record.status,
    startTime: record.startTime,
    endTime: record.endTime ?? undefined,
    provider_event_id: record.providerEventId ?? undefined,
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

/** Test helper: closes the underlying DB pool / connections. */
export async function closeRepositories() {
  await appointmentsRepo.close();
  await oauthTokensRepo.close();
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

// /v1/services stays a stub -- out of scope for this task (no services
// table exists yet; see docs/REALITY-CHECK.md).
app.get('/v1/services', (_req, res) => res.json({ services: [] }));

// Real calendar availability when accountId/provider/calendarId are given
// (queries the connected calendar via the Python connectors and computes
// free slots); falls back to the historical `{ slots: [] }` stub when
// they're not, so existing callers (e.g. packages/adapters/mcp, which
// today only sends serviceId/start/end/tz) keep working unchanged.
app.get('/v1/availability', async (req, res) => {
  const { accountId, provider, calendarId, start, end } = req.query;
  const slotMinutes = Number(req.query.slotMinutes) || 30;
  if (!accountId || !provider || !calendarId || !start || !end) {
    return res.json({ slots: [] });
  }
  if (typeof provider !== 'string' || !isOAuthProvider(provider)) {
    return res.status(400).json({ error: `unsupported provider: ${provider}` });
  }
  if (typeof start !== 'string' || typeof end !== 'string' || typeof calendarId !== 'string') {
    return res.status(400).json({ error: 'accountId, calendarId, start, and end must be strings' });
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
    // retried request never creates a second real calendar event. (Two
    // concurrent *first* requests with the same key can each pass this
    // check and both call the calendar connector -- the DB's unique
    // constraint on idempotency_key still prevents a duplicate DB row,
    // but a stray duplicate calendar event is possible in that race. Not
    // addressed here; would need a short-lived claim/lock to close.)
    const existing = await appointmentsRepo.getByIdempotencyKey(key);
    if (existing) {
      return res.status(200).json(toAppointmentResponse(existing));
    }

    let providerEventId: string | undefined;
    if (provider) {
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
});

app.post('/v1/appointments/:id/cancel', verifyHmac, async (req, res) => {
  try {
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
