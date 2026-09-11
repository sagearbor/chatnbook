import type { CreateServiceInput, ServiceRecord, ServicesRepository } from './services-repo.js';

/** In-memory test double for ServicesRepository -- mirrors the Postgres
 * implementation's semantics so tests written against it exercise the
 * same contract, without requiring Docker/Postgres to be running. */
export class InMemoryServicesRepository implements ServicesRepository {
  private byId = new Map<string, ServiceRecord>();

  async create(input: CreateServiceInput): Promise<ServiceRecord> {
    const now = new Date().toISOString();
    const record: ServiceRecord = {
      id: input.id,
      accountId: input.accountId,
      name: input.name,
      durationMinutes: input.durationMinutes,
      bufferMinutes: input.bufferMinutes ?? 0,
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(record.id, record);
    return record;
  }

  async getById(id: string): Promise<ServiceRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async listByAccount(accountId: string): Promise<ServiceRecord[]> {
    return [...this.byId.values()].filter((s) => s.accountId === accountId);
  }

  async reset(): Promise<void> {
    this.byId.clear();
  }

  async close(): Promise<void> {
    // no-op
  }
}
