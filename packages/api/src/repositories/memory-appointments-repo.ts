import crypto from 'crypto';
import type {
  AppointmentRecord,
  AppointmentsRepository,
  CreateAppointmentInput,
} from './appointments-repo.js';

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
      endTime: null,
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
    const updated: AppointmentRecord = {
      ...existing,
      startTime: newStartTime,
      status: 'confirmed',
      updatedAt: new Date().toISOString(),
    };
    this.byId.set(id, updated);
    return updated;
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
