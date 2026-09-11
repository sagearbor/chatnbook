import crypto from 'crypto';
import pg from 'pg';
import type {
  AppointmentRecord,
  AppointmentsRepository,
  CreateAppointmentInput,
} from './appointments-repo.js';

const { Pool } = pg;

interface AppointmentRow {
  id: string;
  idempotency_key: string;
  account_id: string;
  service_id: string;
  start_time: Date;
  end_time: Date | null;
  status: AppointmentRecord['status'];
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  notes: string | null;
  source: string | null;
  metadata: Record<string, unknown> | null;
  provider_event_id: string | null;
  provider: string | null;
  calendar_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: AppointmentRow): AppointmentRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    accountId: row.account_id,
    serviceId: row.service_id,
    startTime: row.start_time.toISOString(),
    endTime: row.end_time ? row.end_time.toISOString() : null,
    status: row.status,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    notes: row.notes,
    source: row.source,
    metadata: row.metadata,
    providerEventId: row.provider_event_id,
    provider: row.provider,
    calendarId: row.calendar_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Real Postgres-backed AppointmentsRepository. Idempotency is enforced by
 * a unique constraint on idempotency_key (see migrations/001_create_appointments.sql):
 * INSERT ... ON CONFLICT DO NOTHING, then re-select on conflict.
 */
export class PgAppointmentsRepository implements AppointmentsRepository {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async createIdempotent(
    input: CreateAppointmentInput
  ): Promise<{ record: AppointmentRecord; created: boolean }> {
    const id = crypto.randomUUID();
    const insertResult = await this.pool.query<AppointmentRow>(
      `INSERT INTO appointments
         (id, idempotency_key, account_id, service_id, start_time, end_time, status,
          customer_name, customer_email, customer_phone, notes, source, metadata,
          provider_event_id, provider, calendar_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'requested', $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        id,
        input.idempotencyKey,
        input.accountId,
        input.serviceId,
        input.startTime,
        input.endTime ?? null,
        input.customer.name,
        input.customer.email,
        input.customer.phone ?? null,
        input.notes ?? null,
        input.source ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.providerEventId ?? null,
        input.provider ?? null,
        input.calendarId ?? null,
      ]
    );

    if (insertResult.rows.length > 0) {
      return { record: toRecord(insertResult.rows[0]), created: true };
    }

    const existing = await this.pool.query<AppointmentRow>(
      'SELECT * FROM appointments WHERE idempotency_key = $1',
      [input.idempotencyKey]
    );
    if (existing.rows.length === 0) {
      throw new Error('createIdempotent: conflict on insert but no existing row found');
    }
    return { record: toRecord(existing.rows[0]), created: false };
  }

  async getById(id: string): Promise<AppointmentRecord | null> {
    const result = await this.pool.query<AppointmentRow>(
      'SELECT * FROM appointments WHERE id = $1',
      [id]
    );
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<AppointmentRecord | null> {
    const result = await this.pool.query<AppointmentRow>(
      'SELECT * FROM appointments WHERE idempotency_key = $1',
      [idempotencyKey]
    );
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async cancel(id: string): Promise<AppointmentRecord | null> {
    const result = await this.pool.query<AppointmentRow>(
      `UPDATE appointments SET status = 'canceled', updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id]
    );
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async reschedule(id: string, newStartTime: string): Promise<AppointmentRecord | null> {
    const result = await this.pool.query<AppointmentRow>(
      // end_time shifts with start_time so the appointment keeps its
      // duration -- otherwise a rescheduled row would carry a stale
      // end_time and listByAccountInRange would misjudge overlaps.
      `UPDATE appointments
          SET start_time = $2,
              end_time = CASE
                WHEN end_time IS NULL THEN NULL
                ELSE $2::timestamptz + (end_time - start_time)
              END,
              status = 'confirmed',
              updated_at = now()
        WHERE id = $1
       RETURNING *`,
      [id, newStartTime]
    );
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async listByAccountInRange(
    accountId: string,
    start: string,
    end: string
  ): Promise<AppointmentRecord[]> {
    // No new migration needed: start_time/end_time already exist. end_time
    // can be null on rows written before the booking handler started
    // persisting it, so fall back to the row's service duration (LEFT JOIN
    // services, since a service can have been deleted) and finally to 30
    // minutes.
    const result = await this.pool.query<AppointmentRow>(
      `SELECT a.*
         FROM appointments a
         LEFT JOIN services s ON s.id = a.service_id
        WHERE a.account_id = $1
          AND a.status <> 'canceled'
          AND a.start_time < $3
          AND COALESCE(
                a.end_time,
                a.start_time + make_interval(mins => COALESCE(s.duration_minutes, 30))
              ) > $2
        ORDER BY a.start_time ASC`,
      [accountId, start, end]
    );
    return result.rows.map(toRecord);
  }

  async tryClaim(idempotencyKey: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO idempotency_claims (idempotency_key) VALUES ($1)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [idempotencyKey]
    );
    return result.rows.length > 0;
  }

  async releaseClaim(idempotencyKey: string): Promise<void> {
    await this.pool.query('DELETE FROM idempotency_claims WHERE idempotency_key = $1', [idempotencyKey]);
  }

  async reset(): Promise<void> {
    await this.pool.query('TRUNCATE appointments');
    await this.pool.query('TRUNCATE idempotency_claims');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
