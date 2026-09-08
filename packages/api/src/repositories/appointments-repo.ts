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
  createdAt: string;
  updatedAt: string;
}

export interface CreateAppointmentInput {
  idempotencyKey: string;
  accountId: string;
  serviceId: string;
  startTime: string;
  customer: { name: string; email: string; phone?: string };
  notes?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  /** Set when a real calendar event was created for this booking (see
   * ../connectors/calendar-connector.ts and index.ts's /v1/appointments
   * handler) -- stored on the same INSERT as the appointment row. */
  providerEventId?: string;
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
  /** Test-only: clears all data. */
  reset(): Promise<void>;
  close(): Promise<void>;
}
