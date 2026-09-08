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

/** Test helper: closes the underlying DB pool / connections. */
export async function closeRepositories() {
  await appointmentsRepo.close();
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

// Still stubs -- not part of this task's scope (see docs/REALITY-CHECK.md).
app.get('/v1/services', (_req, res) => res.json({ services: [] }));
app.get('/v1/availability', (_req, res) => res.json({ slots: [] }));

app.post('/v1/appointments', verifyHmac, async (req, res) => {
  const key = req.header('Idempotency-Key');
  if (!key) {
    return res.status(400).json({ error: 'Idempotency-Key required' });
  }
  const { accountId, serviceId, startTime, customer } = req.body || {};
  if (!accountId || !serviceId || !startTime || !customer?.name || !customer?.email) {
    return res.status(400).json({
      error: 'accountId, serviceId, startTime, and customer.name/customer.email are required',
    });
  }

  try {
    const { record, created } = await appointmentsRepo.createIdempotent({
      idempotencyKey: key,
      accountId,
      serviceId,
      startTime,
      customer,
      notes: req.body?.notes,
      source: req.body?.source,
      metadata: req.body?.metadata,
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
