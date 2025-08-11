import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { sendNotification, extractContact } from './notify.js';
import { wellKnown } from '../../discovery/well_known.js';

export const app = express();
app.use(cors());
app.use(express.json());

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

// Simple in-memory idempotency store
const idempotencyStore = new Map<string, unknown>();

export function resetIdempotency() {
  idempotencyStore.clear();
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

app.use(wellKnown);

app.get('/health', (_req, res) => res.json({ ok: true }));

// Serve OpenAPI
app.get(['/openapi.json', '/.well-known/openapi.json'], (_req, res) => {
  const p = path.join(__dirname, '../openapi/openapi.json');
  const spec = fs.readFileSync(p, 'utf-8');
  res.type('application/json').send(spec);
});

// Stubs
app.get('/v1/services', (_req, res) => res.json({ services: [] }));
app.get('/v1/availability', (_req, res) => res.json({ slots: [] }));
app.post('/v1/appointments', verifyHmac, (req, res) => {
  const key = req.header('Idempotency-Key');
  if (!key) {
    return res.status(400).json({ error: 'Idempotency-Key required' });
  }
  if (idempotencyStore.has(key)) {
    return res.status(200).json(idempotencyStore.get(key));
  }
  const response = { id: crypto.randomUUID(), status: 'requested' };
  idempotencyStore.set(key, response);
  sendNotification({ to: extractContact(req), type: 'appointment_requested', payload: response });
  res.status(201).json(response);
});
app.post('/v1/appointments/:id/cancel', verifyHmac, (req, res) => {
  const response = { id: req.params.id, status: 'canceled' };
  sendNotification({ to: extractContact(req), type: 'appointment_canceled', payload: response });
  res.json(response);
});
app.post('/v1/appointments/:id/reschedule', verifyHmac, (req, res) => {
  const response = { id: req.params.id, status: 'confirmed' };
  sendNotification({ to: extractContact(req), type: 'appointment_rescheduled', payload: response });
  res.json(response);
});

if (process.env.NODE_ENV !== 'test') {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`API listening on :${port}`));
}
