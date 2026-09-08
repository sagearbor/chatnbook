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
      providerEventId: null,
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

  async reset(): Promise<void> {
    this.byId.clear();
    this.byIdempotencyKey.clear();
  }

  async close(): Promise<void> {
    // no-op
  }
}
