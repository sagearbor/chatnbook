import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendNotification, extractContact } from './notify.js';
import { businessHoursFromEnv, computeBusinessHoursSlots } from './business-hours.js';
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

// --- Filesystem layout -------------------------------------------------
// This package is "type": "module", so __dirname doesn't exist. Everything
// that used to (incorrectly) join onto __dirname resolves from
// import.meta.url instead. tsc's rootDir lands the compiled entrypoint at
// packages/api/dist/api/src/index.js, so rather than hard-coding how many
// `..` that is, walk up to the directory that actually holds this
// package's package.json.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function findApiPackageRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        if (JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).name === '@smb/api') return dir;
      } catch {
        // keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(from, '..', '..', '..');
}

const API_PACKAGE_ROOT = findApiPackageRoot(MODULE_DIR);
const OPENAPI_JSON_PATH = path.join(API_PACKAGE_ROOT, 'openapi', 'openapi.json');
const DEMO_HTML_PATH = path.join(API_PACKAGE_ROOT, 'public', 'demo.html');
/** Built widget assets (packages/widget/dist), overridable for tests and
 * for deployments that stage the widget somewhere else. */
const WIDGET_DIST_DIR = process.env.WIDGET_DIST_DIR
  ? path.resolve(process.env.WIDGET_DIST_DIR)
  : path.resolve(API_PACKAGE_ROOT, '..', 'widget', 'dist');

export const app = express();
// Cloud Run terminates TLS at the proxy; without this req.protocol is
// always 'http' and every self-referential URL we publish would be wrong.
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

/** The absolute origin clients should use to reach this API: PUBLIC_API_BASE
 * when set (the deployed case), otherwise derived from the request. */
function publicBaseUrl(req: express.Request): string {
  const configured = process.env.PUBLIC_API_BASE;
  if (configured) return configured.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

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

/** Test-only: direct access to the appointments repository, so tests can
 * exercise repository-level behaviour (e.g. listByAccountInRange against
 * real Postgres) without going through HTTP. */
export function getAppointmentsRepoForTest(): AppointmentsRepository {
  return appointmentsRepo;
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

app.get('/.well-known/ai-actions.json', (req, res) => {
  // Absolute URLs, so an agent that fetched this document from the
  // deployed host doesn't have to guess where to POST.
  res.json(getWellKnownDocument(publicBaseUrl(req)));
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// Serve OpenAPI. The spec file ships with a placeholder `servers[0].url`;
// rewrite it at serve time to wherever this instance actually is, so
// generated clients and agent tooling point at the right host.
app.get(['/openapi.json', '/.well-known/openapi.json'], (req, res) => {
  try {
    const spec = JSON.parse(fs.readFileSync(OPENAPI_JSON_PATH, 'utf-8'));
    const url = publicBaseUrl(req);
    if (Array.isArray(spec.servers) && spec.servers.length > 0) {
      spec.servers[0] = { ...spec.servers[0], url };
    } else {
      spec.servers = [{ url }];
    }
    res.type('application/json').send(JSON.stringify(spec, null, 2));
  } catch (err) {
    console.error('failed to serve openapi.json', err);
    res.status(500).json({ error: 'Failed to load OpenAPI document' });
  }
});

// --- Browser widget + demo page ---------------------------------------
// The widget is built by packages/widget into dist/. Serving it from the
// API means a customer's site only needs one <script src> pointing here --
// no separate CDN, no CORS setup. A missing dist directory is a warning,
// never a crash: the API is perfectly useful without the widget.
if (!fs.existsSync(WIDGET_DIST_DIR)) {
  console.warn(
    `widget dist directory not found at ${WIDGET_DIST_DIR}; /widget.js and /widget/* will 404 (set WIDGET_DIST_DIR to override)`
  );
}

/** Sends one file out of the widget dist dir, 404ing if it isn't there. */
function sendWidgetFile(res: express.Response, relativePath: string) {
  const filePath = path.join(WIDGET_DIST_DIR, relativePath);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `widget asset not built: ${relativePath}` });
  }
  res.sendFile(filePath);
}

// The stable public entrypoint embedded on customer sites:
//   <script src="https://.../widget.js" data-account="acct_x" async></script>
app.get('/widget.js', (_req, res) => sendWidgetFile(res, 'loader.js'));
app.use('/widget', express.static(WIDGET_DIST_DIR, { fallthrough: true }));
app.use('/widget', (_req, res) => res.status(404).json({ error: 'widget asset not found' }));

app.get('/demo', (_req, res) => {
  if (!fs.existsSync(DEMO_HTML_PATH)) {
    return res.status(404).json({ error: 'demo page not available' });
  }
  res.sendFile(DEMO_HTML_PATH);
});

app.get('/', (_req, res) => res.redirect('/demo'));

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

/** Constant-time compare of two secrets of possibly different lengths. */
function secretsMatch(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Admin endpoint for creating a service. Guarded by a shared admin key
// rather than the agent HMAC: this is operator tooling (and the deploy's
// only way to add services when there's no database shell to seed from),
// not an agent-facing API. Unset ADMIN_API_KEY means the endpoint is
// deliberately not available at all -- 503, not 401, so an operator can
// tell "I got the key wrong" from "this instance has no admin key".
app.post('/v1/services', async (req, res) => {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    return res.status(503).json({ error: 'admin API not configured' });
  }
  const provided = req.header('X-Admin-Key');
  if (!provided || !secretsMatch(provided, adminKey)) {
    return res.status(401).json({ error: 'invalid admin key' });
  }
  const { accountId, name, durationMinutes, bufferMinutes } = req.body || {};
  if (typeof accountId !== 'string' || !accountId || typeof name !== 'string' || !name) {
    return res.status(400).json({ error: 'accountId and name are required' });
  }
  const duration = Number(durationMinutes);
  if (!Number.isFinite(duration) || duration <= 0) {
    return res.status(400).json({ error: 'durationMinutes must be a positive number' });
  }
  const buffer = bufferMinutes === undefined ? 0 : Number(bufferMinutes);
  if (!Number.isFinite(buffer) || buffer < 0) {
    return res.status(400).json({ error: 'bufferMinutes must be a non-negative number' });
  }
  try {
    const record = await servicesRepo.create({
      id: typeof req.body?.id === 'string' && req.body.id ? req.body.id : `svc_${crypto.randomUUID()}`,
      accountId,
      name,
      durationMinutes: Math.round(duration),
      bufferMinutes: Math.round(buffer),
    });
    res.status(201).json(toServiceResponse(record));
  } catch (err) {
    console.error('failed to create service', err);
    res.status(500).json({ error: 'Failed to create service' });
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
  // Historical stub shape: without an account and a window there's nothing
  // meaningful to compute, and existing callers (packages/adapters/mcp
  // sends only serviceId/start/end/tz) depend on getting `{ slots: [] }`
  // rather than a 400.
  if (!accountId || !start || !end) {
    return res.json({ slots: [] });
  }
  if (typeof accountId !== 'string' || typeof start !== 'string' || typeof end !== 'string') {
    return res.status(400).json({ error: 'accountId, start, and end must be strings' });
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

  // No provider: the account hasn't connected a calendar (the default on
  // the hosted demo, which runs with no database and no OAuth). Fall back
  // to the configured business hours minus what's already booked, so
  // /v1/availability is useful out of the box instead of returning an
  // empty list forever.
  if (!provider) {
    try {
      const { windows, timeZone } = businessHoursFromEnv();
      const booked = await appointmentsRepo.listByAccountInRange(accountId, start, end);
      const slots = computeBusinessHoursSlots({
        start,
        end,
        slotMinutes,
        windows,
        timeZone,
        busy: booked.map((a) => ({
          start: a.startTime,
          end: a.endTime ?? new Date(new Date(a.startTime).getTime() + slotMinutes * 60_000).toISOString(),
        })),
      });
      return res.json({ slots });
    } catch (err) {
      console.error('failed to compute business-hours availability', err);
      return res.status(500).json({ error: 'Failed to compute availability' });
    }
  }

  if (typeof provider !== 'string' || !isOAuthProvider(provider)) {
    return res.status(400).json({ error: `unsupported provider: ${provider}` });
  }
  if (!calendarId || typeof calendarId !== 'string') {
    // Historical behaviour: provider without calendarId is an incomplete
    // request, answered with the empty stub rather than an error.
    return res.json({ slots: [] });
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

  return bookWithIdempotency(req, res, key, {
    accountId,
    serviceId,
    startTime,
    customer,
    notes: req.body?.notes,
    source: req.body?.source,
    metadata: req.body?.metadata,
    provider,
    calendarId,
    durationMinutes,
    // Backward compatibility with packages/adapters/mcp, which sends
    // serviceIds that may not exist in the services table at all.
    allowUnknownService: true,
  });
});

// Browser booking path. No X-Signature: a widget running on a customer's
// site can't hold a shared secret, so this route is deliberately
// unauthenticated and leans on the per-IP rate limiter above plus the
// server-side service lookup (the body can't influence duration, and
// provider/calendarId are ignored entirely -- a public caller must never
// be able to aim a write at an arbitrary calendar). Idempotency-Key is
// optional here because a browser retry is usually a fresh page load; when
// one is supplied, replay works exactly as on the signed route.
app.post('/v1/public/appointments', async (req, res) => {
  const key = req.header('Idempotency-Key') || `pub_${crypto.randomUUID()}`;
  const { accountId, serviceId, startTime, customer } = req.body || {};
  if (!accountId || !serviceId || !startTime || !customer?.name || !customer?.email) {
    return res.status(400).json({
      error: 'accountId, serviceId, startTime, and customer.name/customer.email are required',
    });
  }
  if (
    typeof accountId !== 'string' ||
    typeof serviceId !== 'string' ||
    typeof startTime !== 'string'
  ) {
    return res.status(400).json({ error: 'accountId, serviceId, and startTime must be strings' });
  }
  return bookWithIdempotency(req, res, key, {
    accountId,
    serviceId,
    startTime,
    customer: {
      name: String(customer.name),
      email: String(customer.email),
      phone: customer.phone === undefined ? undefined : String(customer.phone),
    },
    notes: typeof req.body?.notes === 'string' ? req.body.notes : undefined,
    source: 'human',
    // provider/calendarId/durationMinutes are intentionally NOT read from
    // the public body. (A future version may look up the account's own
    // connected calendar server-side; it will never trust the client's.)
    allowUnknownService: false,
  });
});

/** The idempotency-key claim dance shared by both booking routes. */
async function bookWithIdempotency(
  req: express.Request,
  res: express.Response,
  key: string,
  body: BookingInput
) {
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
      return await handleCreateAppointment(req, res, key, body);
    } finally {
      await appointmentsRepo.releaseClaim(key);
    }
  } catch (err) {
    console.error('failed to create appointment', err);
    res.status(500).json({ error: 'Failed to create appointment' });
  }
}

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

interface BookingInput {
  accountId: string;
  serviceId: string;
  startTime: string;
  customer: { name: string; email: string; phone?: string };
  notes?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  provider?: string;
  calendarId?: string;
  durationMinutes?: number;
  /**
   * Signed (HMAC) route only. packages/adapters/mcp books serviceIds that
   * don't exist as rows at all, so that route tolerates an unknown service
   * and falls back to the body's durationMinutes (then 30). The public
   * browser route sets this false: the service must be real and must belong
   * to the account, and its duration is the only duration that counts.
   */
  allowUnknownService: boolean;
}

/** The actual booking logic, run only by the request that won the
 * idempotency-key claim above. Sends the response itself (so the caller
 * can `return` its result directly) and always returns after responding. */
async function handleCreateAppointment(
  req: express.Request,
  res: express.Response,
  key: string,
  body: BookingInput
) {
  const {
    accountId,
    serviceId,
    startTime,
    customer,
    provider,
    calendarId,
    durationMinutes,
    allowUnknownService,
  } = body;
  try {
    const startDate = new Date(startTime);
    if (Number.isNaN(startDate.getTime())) {
      return res.status(400).json({ error: 'startTime must be a valid ISO-8601 date-time' });
    }

    // The appointment's length comes from the service, not the client --
    // that's what makes the overlap check below meaningful and what gets
    // persisted as end_time.
    const service = await servicesRepo.getById(serviceId);
    if (!service || service.accountId !== accountId) {
      if (!allowUnknownService) {
        return res.status(404).json({ error: `unknown serviceId: ${serviceId}` });
      }
    }
    const durationMin =
      service && service.accountId === accountId
        ? service.durationMinutes
        : Number(durationMinutes) > 0
          ? Number(durationMinutes)
          : 30;
    const endDateForBooking = new Date(startDate.getTime() + durationMin * 60_000);
    const startIsoForBooking = startDate.toISOString();
    const endIsoForBooking = endDateForBooking.toISOString();

    // Double-booking guard that doesn't depend on a calendar provider:
    // reject if this account already has a non-canceled appointment
    // covering any part of the requested window.
    const overlapping = await appointmentsRepo.listByAccountInRange(
      accountId,
      startIsoForBooking,
      endIsoForBooking
    );
    if (overlapping.length > 0) {
      return res.status(409).json({ error: 'slot no longer available' });
    }

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
      const endDate = endDateForBooking;
      const startIso = startIsoForBooking;
      const endIso = endIsoForBooking;

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
      // Persisted so a later overlap check knows how long this booking
      // actually occupies without re-resolving its service.
      endTime: endIsoForBooking,
      customer,
      notes: body.notes,
      source: body.source,
      metadata: body.metadata,
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

// --- Demo seed ---------------------------------------------------------
// The hosted demo runs with no database (in-memory repositories), so every
// cold start begins with an empty services table. SEED_DEMO_ACCOUNT makes
// that instance immediately bookable by ensuring two services with stable,
// documented ids exist for the named account. Idempotent by construction:
// the ids are fixed, so a restart (or a Postgres-backed instance that was
// already seeded) skips whatever is already there.
const DEMO_SERVICES = [
  { id: 'svc_demo_consult', name: '30-minute consultation', durationMinutes: 30, bufferMinutes: 0 },
  { id: 'svc_demo_full', name: '60-minute appointment', durationMinutes: 60, bufferMinutes: 10 },
];

export async function seedDemoAccount(accountId: string): Promise<number> {
  let createdCount = 0;
  for (const svc of DEMO_SERVICES) {
    const existing = await servicesRepo.getById(svc.id);
    if (existing) continue;
    await servicesRepo.create({ ...svc, accountId });
    createdCount++;
  }
  return createdCount;
}

async function seedDemoAccountIfConfigured(): Promise<void> {
  const accountId = process.env.SEED_DEMO_ACCOUNT;
  if (!accountId) return;
  const created = await seedDemoAccount(accountId);
  console.log(
    `seeded demo account ${accountId}: ${created} service(s) created, ${DEMO_SERVICES.length - created} already present (${DEMO_SERVICES.map((s) => s.id).join(', ')})`
  );
}

const demoSeedPromise = seedDemoAccountIfConfigured().catch((err) => {
  console.error('failed to seed demo account', err);
});

/** Test helper: resolves once the SEED_DEMO_ACCOUNT seed (if any) is done. */
export function demoSeedReady(): Promise<void> {
  return demoSeedPromise;
}

if (process.env.NODE_ENV !== 'test') {
  const port = process.env.PORT || 3000;
  demoSeedPromise.then(() => app.listen(port, () => console.log(`API listening on :${port}`)));
}
