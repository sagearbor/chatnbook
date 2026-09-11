// Repository interface for services (GET /v1/services and the serviceId
// wiring in GET /v1/availability). Same Pg/in-memory split as
// appointments-repo.ts: PgServicesRepository (real Postgres, used whenever
// DATABASE_URL is set) and InMemoryServicesRepository (a test double, used
// when it isn't).

export interface ServiceRecord {
  id: string;
  accountId: string;
  name: string;
  durationMinutes: number;
  bufferMinutes: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateServiceInput {
  id: string;
  accountId: string;
  name: string;
  durationMinutes: number;
  bufferMinutes?: number;
}

export interface ServicesRepository {
  /** Test/seed helper: no admin HTTP endpoint exists yet for creating
   * services (out of scope -- see docs/REALITY-CHECK.md), so tests and any
   * future admin tooling create rows directly through this. */
  create(input: CreateServiceInput): Promise<ServiceRecord>;
  getById(id: string): Promise<ServiceRecord | null>;
  listByAccount(accountId: string): Promise<ServiceRecord[]>;
  /** Test-only: clears all data. */
  reset(): Promise<void>;
  close(): Promise<void>;
}
