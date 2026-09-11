import pg from 'pg';
import type { CreateServiceInput, ServiceRecord, ServicesRepository } from './services-repo.js';

const { Pool } = pg;

interface ServiceRow {
  id: string;
  account_id: string;
  name: string;
  duration_minutes: number;
  buffer_minutes: number;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: ServiceRow): ServiceRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    durationMinutes: row.duration_minutes,
    bufferMinutes: row.buffer_minutes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Real Postgres-backed ServicesRepository (see migrations/003_create_services.sql). */
export class PgServicesRepository implements ServicesRepository {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async create(input: CreateServiceInput): Promise<ServiceRecord> {
    const result = await this.pool.query<ServiceRow>(
      `INSERT INTO services (id, account_id, name, duration_minutes, buffer_minutes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.id, input.accountId, input.name, input.durationMinutes, input.bufferMinutes ?? 0]
    );
    return toRecord(result.rows[0]);
  }

  async getById(id: string): Promise<ServiceRecord | null> {
    const result = await this.pool.query<ServiceRow>('SELECT * FROM services WHERE id = $1', [id]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async listByAccount(accountId: string): Promise<ServiceRecord[]> {
    const result = await this.pool.query<ServiceRow>(
      'SELECT * FROM services WHERE account_id = $1 ORDER BY created_at ASC',
      [accountId]
    );
    return result.rows.map(toRecord);
  }

  async reset(): Promise<void> {
    await this.pool.query('TRUNCATE services');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
