import crypto from 'crypto';
import type {
  AppointmentRecord,
  AppointmentsRepository,
  CreateAppointmentInput,
} from './appointments-repo.js';

/** Assumed length of an appointment whose endTime was never persisted --
 * matches the Postgres implementation's fallback when the row's service
 * is gone. */
const DEFAULT_DURATION_MINUTES = 30;

/**
 * In-memory test double for AppointmentsRepository. Mirrors the Postgres
 * implementation's idempotency and not-found semantics so tests written
 * against it exercise the same contract, without requiring Docker/Postgres
 * to be running.
 */
export class InMemoryAppointmentsRepository implements AppointmentsRepository {
  private byId = new Map<string, AppointmentRecord>();
  private byIdempotencyKey = new Map<string, string>();
  private claims = new Set<string>();

  async createIdempotent(
    input: CreateAppointmentInput
  ): Promise<{ record: AppointmentRecord; created: boolean }> {
    const existingId = this.byIdempotencyKey.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.byId.get(existingId);
      if (existing) return { record: existing, created: false };
    }

    const now = new Date().toISOString();
    const record: AppointmentRecord = {
      id: crypto.randomUUID(),
      idempotencyKey: input.idempotencyKey,
      accountId: input.accountId,
      serviceId: input.serviceId,
      startTime: input.startTime,
      endTime: input.endTime ?? null,
      status: 'requested',
      customerName: input.customer.name,
      customerEmail: input.customer.email,
      customerPhone: input.customer.phone ?? null,
      notes: input.notes ?? null,
      source: input.source ?? null,
      metadata: input.metadata ?? null,
      providerEventId: input.providerEventId ?? null,
      provider: input.provider ?? null,
      calendarId: input.calendarId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(record.id, record);
    this.byIdempotencyKey.set(input.idempotencyKey, record.id);
    return { record, created: true };
  }

  async getById(id: string): Promise<AppointmentRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<AppointmentRecord | null> {
    const id = this.byIdempotencyKey.get(idempotencyKey);
    return id ? this.byId.get(id) ?? null : null;
  }

  async cancel(id: string): Promise<AppointmentRecord | null> {
    const existing = this.byId.get(id);
    if (!existing) return null;
    const updated: AppointmentRecord = {
      ...existing,
      status: 'canceled',
      updatedAt: new Date().toISOString(),
    };
    this.byId.set(id, updated);
    return updated;
  }

  async reschedule(id: string, newStartTime: string): Promise<AppointmentRecord | null> {
    const existing = this.byId.get(id);
    if (!existing) return null;
    // Keep the appointment's duration: shift endTime by the same delta, so
    // a rescheduled row doesn't carry a stale endTime into the overlap
    // check (mirrors the Postgres implementation).
    const durationMs = existing.endTime
      ? new Date(existing.endTime).getTime() - new Date(existing.startTime).getTime()
      : null;
    const updated: AppointmentRecord = {
      ...existing,
      startTime: newStartTime,
      endTime:
        durationMs === null
          ? null
          : new Date(new Date(newStartTime).getTime() + durationMs).toISOString(),
      status: 'confirmed',
      updatedAt: new Date().toISOString(),
    };
    this.byId.set(id, updated);
    return updated;
  }

  async listByAccountInRange(
    accountId: string,
    start: string,
    end: string
  ): Promise<AppointmentRecord[]> {
    const rangeStart = new Date(start).getTime();
    const rangeEnd = new Date(end).getTime();
    return [...this.byId.values()]
      .filter((a) => a.accountId === accountId && a.status !== 'canceled')
      .filter((a) => {
        const aStart = new Date(a.startTime).getTime();
        // Mirrors the Pg implementation's COALESCE on end_time. Every row
        // this repository writes now carries an endTime (the booking
        // handler computes it from the service's duration), so the
        // fallback only matters for rows seeded directly by a test.
        const aEnd = a.endTime
          ? new Date(a.endTime).getTime()
          : aStart + DEFAULT_DURATION_MINUTES * 60_000;
        return aStart < rangeEnd && aEnd > rangeStart;
      })
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  }

  async tryClaim(idempotencyKey: string): Promise<boolean> {
    // No `await` between the check and the mutation, so this is atomic
    // with respect to other requests in the same process (Node won't
    // interleave two calls to this function mid-body) -- the same
    // guarantee the Postgres implementation gets from its unique
    // constraint, just via the single-threaded event loop instead of the DB.
    if (this.claims.has(idempotencyKey)) return false;
    this.claims.add(idempotencyKey);
    return true;
  }

  async releaseClaim(idempotencyKey: string): Promise<void> {
    this.claims.delete(idempotencyKey);
  }

  async reset(): Promise<void> {
    this.byId.clear();
    this.byIdempotencyKey.clear();
    this.claims.clear();
  }

  async close(): Promise<void> {
    // no-op
  }
}
