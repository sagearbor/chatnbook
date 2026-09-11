// Repository interface for appointment persistence. Two implementations
// exist: PgAppointmentsRepository (real Postgres, used whenever
// DATABASE_URL is set) and InMemoryAppointmentsRepository (a test double,
// used when it isn't -- e.g. fast unit tests that don't need Docker up).

export type AppointmentStatus =
  | 'requested'
  | 'tentative'
  | 'confirmed'
  | 'canceled'
  | 'no_show';

export interface AppointmentRecord {
  id: string;
  idempotencyKey: string;
  accountId: string;
  serviceId: string;
  startTime: string;
  endTime: string | null;
  status: AppointmentStatus;
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  notes: string | null;
  source: string | null;
  metadata: Record<string, unknown> | null;
  providerEventId: string | null;
  /** Which calendar connector was used to create providerEventId ('google'
   * | 'microsoft'), or null when no provider was set at booking time. Read
   * back on cancel (see index.ts) to know which connector to call to
   * delete the real event. */
  provider: string | null;
  /** The calendarId the event was created on, or null when no provider was
   * set. Needed alongside provider + providerEventId to delete the event. */
  calendarId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAppointmentInput {
  idempotencyKey: string;
  accountId: string;
  serviceId: string;
  startTime: string;
  /** When the appointment ends -- startTime + the service's durationMinutes,
   * computed by the booking handler in index.ts. Persisted so the overlap
   * check (listByAccountInRange) can tell how long an existing booking
   * occupies without re-looking-up its service. Optional only for
   * backwards compatibility with callers that predate it. */
  endTime?: string;
  customer: { name: string; email: string; phone?: string };
  notes?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  /** Set when a real calendar event was created for this booking (see
   * ../connectors/calendar-connector.ts and index.ts's /v1/appointments
   * handler) -- stored on the same INSERT as the appointment row. */
  providerEventId?: string;
  /** The provider/calendarId used to create providerEventId, stored
   * alongside it so cancellation can later delete the real event. Both are
   * omitted together with providerEventId when no provider was set. */
  provider?: string;
  calendarId?: string;
}

export interface AppointmentsRepository {
  /**
   * Creates the appointment unless a row already exists for this
   * idempotency key, in which case the existing row is returned instead
   * (created: false).
   */
  createIdempotent(
    input: CreateAppointmentInput
  ): Promise<{ record: AppointmentRecord; created: boolean }>;
  getById(id: string): Promise<AppointmentRecord | null>;
  /** Looks up a previously-created appointment by its Idempotency-Key,
   * without creating anything. Used to detect a retry *before* doing any
   * (expensive, side-effecting) calendar work in index.ts. */
  getByIdempotencyKey(idempotencyKey: string): Promise<AppointmentRecord | null>;
  cancel(id: string): Promise<AppointmentRecord | null>;
  reschedule(id: string, newStartTime: string): Promise<AppointmentRecord | null>;
  /**
   * All *non-canceled* appointments for `accountId` whose own
   * [startTime, endTime) interval overlaps [start, end). Backs two things
   * in index.ts: the double-booking 409 on both booking routes, and the
   * business-hours availability fallback (which subtracts these from the
   * generated slots).
   *
   * Rows whose end_time is null (written before endTime was persisted)
   * fall back to the row's service's durationMinutes, or 30 minutes when
   * that service no longer exists.
   */
  listByAccountInRange(
    accountId: string,
    start: string,
    end: string
  ): Promise<AppointmentRecord[]>;
  /**
   * Atomically claims an idempotency key before any side-effecting work
   * begins (see index.ts's POST /v1/appointments) -- returns true if this
   * call is the first to claim it, false if another (still in-flight, or
   * already-finished-or-failed) request holds/held the claim. Backed by a
   * DB-level unique constraint (migrations/005_create_idempotency_claims.sql)
   * so it's safe across concurrent requests hitting different processes,
   * not just concurrent promises within one.
   */
  tryClaim(idempotencyKey: string): Promise<boolean>;
  /** Releases a claim taken by tryClaim, whether the claiming request
   * succeeded or failed -- always call this in a finally block so a failed
   * attempt doesn't permanently lock out retries with the same key. */
  releaseClaim(idempotencyKey: string): Promise<void>;
  /** Test-only: clears all data. */
  reset(): Promise<void>;
  close(): Promise<void>;
}
