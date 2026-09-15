import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type {
  AppointmentRecord,
  AppointmentsRepository,
  CreateAppointmentInput,
} from './appointments-repo.js';
import { getFirestoreDb, closeFirestoreClient } from './firestore-client.js';

/** Assumed length of an appointment whose endTime was never persisted --
 * matches the Postgres/in-memory implementations' fallback when the row's
 * service is gone. */
const DEFAULT_DURATION_MINUTES = 30;

const APPOINTMENTS_COLLECTION = 'appointments';
/** Maps an Idempotency-Key to the appointment id it created. A *separate*
 * document (rather than a field query on `appointments`) so
 * createIdempotent can enforce uniqueness with a single-document
 * transactional read+write instead of a query, which is both simpler and
 * avoids needing a composite index. */
const IDEMPOTENCY_KEYS_COLLECTION = 'appointment_idempotency_keys';
/** Backs tryClaim/releaseClaim -- see appointments-repo.ts's doc comment.
 * A document's mere existence *is* the claim; DocumentReference.create()
 * fails with ALREADY_EXISTS when another request already holds it, giving
 * the same atomic "first writer wins" guarantee the Postgres
 * implementation gets from a unique-constraint INSERT. */
const CLAIMS_COLLECTION = 'idempotency_claims';

interface AppointmentDoc {
  id: string;
  idempotencyKey: string;
  accountId: string;
  serviceId: string;
  startTime: string;
  endTime: string | null;
  status: AppointmentRecord['status'];
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  notes: string | null;
  source: string | null;
  metadata: Record<string, unknown> | null;
  providerEventId: string | null;
  provider: string | null;
  calendarId: string | null;
  createdAt: string;
  updatedAt: string;
}

function toRecord(doc: AppointmentDoc): AppointmentRecord {
  return { ...doc };
}

/**
 * Firestore-backed AppointmentsRepository (Firestore Native mode,
 * arborfam-hub's default database -- free tier, no Postgres needed).
 * Selected instead of Pg/in-memory when FIRESTORE_PROJECT_ID is set and
 * DATABASE_URL isn't (see index.ts). Exists so the Cloud Run demo, which
 * scales to zero between visits, keeps bookings across a cold start
 * instead of losing them the way the in-memory repository does.
 */
export class FirestoreAppointmentsRepository implements AppointmentsRepository {
  private db: Firestore;

  constructor(projectId: string) {
    this.db = getFirestoreDb(projectId);
  }

  async createIdempotent(
    input: CreateAppointmentInput
  ): Promise<{ record: AppointmentRecord; created: boolean }> {
    const idemRef = this.db.collection(IDEMPOTENCY_KEYS_COLLECTION).doc(input.idempotencyKey);
    const newId = crypto.randomUUID();
    const apptRef = this.db.collection(APPOINTMENTS_COLLECTION).doc(newId);

    return this.db.runTransaction(async (tx) => {
      const idemSnap = await tx.get(idemRef);
      if (idemSnap.exists) {
        const existingId = idemSnap.data()!.appointmentId as string;
        const existingSnap = await tx.get(this.db.collection(APPOINTMENTS_COLLECTION).doc(existingId));
        if (!existingSnap.exists) {
          throw new Error('createIdempotent: idempotency key mapped to a missing appointment');
        }
        return { record: toRecord(existingSnap.data() as AppointmentDoc), created: false };
      }

      const now = new Date().toISOString();
      const doc: AppointmentDoc = {
        id: newId,
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
      tx.set(apptRef, doc);
      tx.set(idemRef, { appointmentId: newId });
      return { record: toRecord(doc), created: true };
    });
  }

  async getById(id: string): Promise<AppointmentRecord | null> {
    const snap = await this.db.collection(APPOINTMENTS_COLLECTION).doc(id).get();
    return snap.exists ? toRecord(snap.data() as AppointmentDoc) : null;
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<AppointmentRecord | null> {
    const idemSnap = await this.db.collection(IDEMPOTENCY_KEYS_COLLECTION).doc(idempotencyKey).get();
    if (!idemSnap.exists) return null;
    return this.getById(idemSnap.data()!.appointmentId as string);
  }

  async cancel(id: string): Promise<AppointmentRecord | null> {
    const ref = this.db.collection(APPOINTMENTS_COLLECTION).doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const updated: AppointmentDoc = {
        ...(snap.data() as AppointmentDoc),
        status: 'canceled',
        updatedAt: new Date().toISOString(),
      };
      tx.set(ref, updated);
      return toRecord(updated);
    });
  }

  async reschedule(id: string, newStartTime: string): Promise<AppointmentRecord | null> {
    const ref = this.db.collection(APPOINTMENTS_COLLECTION).doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const existing = snap.data() as AppointmentDoc;
      // Keep the appointment's duration: shift endTime by the same delta
      // as startTime, mirroring the Postgres/in-memory implementations, so
      // a rescheduled row doesn't carry a stale endTime into the overlap
      // check.
      const durationMs = existing.endTime
        ? new Date(existing.endTime).getTime() - new Date(existing.startTime).getTime()
        : null;
      const updated: AppointmentDoc = {
        ...existing,
        startTime: newStartTime,
        endTime:
          durationMs === null
            ? null
            : new Date(new Date(newStartTime).getTime() + durationMs).toISOString(),
        status: 'confirmed',
        updatedAt: new Date().toISOString(),
      };
      tx.set(ref, updated);
      return toRecord(updated);
    });
  }

  async listByAccountInRange(
    accountId: string,
    start: string,
    end: string
  ): Promise<AppointmentRecord[]> {
    // A single equality filter needs no composite index. The overlap
    // window and the "not canceled" filter are applied client-side --
    // fine at demo/small-account scale, and it avoids depending on a
    // Firestore composite index existing (which the emulator/a fresh
    // Firestore database wouldn't have unless explicitly deployed).
    const snap = await this.db
      .collection(APPOINTMENTS_COLLECTION)
      .where('accountId', '==', accountId)
      .get();
    const rangeStart = new Date(start).getTime();
    const rangeEnd = new Date(end).getTime();
    return snap.docs
      .map((d) => toRecord(d.data() as AppointmentDoc))
      .filter((a) => a.status !== 'canceled')
      .filter((a) => {
        const aStart = new Date(a.startTime).getTime();
        const aEnd = a.endTime
          ? new Date(a.endTime).getTime()
          : aStart + DEFAULT_DURATION_MINUTES * 60_000;
        return aStart < rangeEnd && aEnd > rangeStart;
      })
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  }

  async tryClaim(idempotencyKey: string): Promise<boolean> {
    try {
      await this.db.collection(CLAIMS_COLLECTION).doc(idempotencyKey).create({
        claimedAt: new Date().toISOString(),
      });
      return true;
    } catch (err) {
      // ALREADY_EXISTS (gRPC code 6) means another request already holds
      // this claim -- the expected, non-exceptional "lost the race" case.
      if (isAlreadyExists(err)) return false;
      throw err;
    }
  }

  async releaseClaim(idempotencyKey: string): Promise<void> {
    await this.db.collection(CLAIMS_COLLECTION).doc(idempotencyKey).delete();
  }

  async reset(): Promise<void> {
    await Promise.all([
      deleteCollection(this.db, APPOINTMENTS_COLLECTION),
      deleteCollection(this.db, IDEMPOTENCY_KEYS_COLLECTION),
      deleteCollection(this.db, CLAIMS_COLLECTION),
    ]);
  }

  async close(): Promise<void> {
    await closeFirestoreClient();
  }
}

function isAlreadyExists(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 6;
}

/** Test/reset-only: deletes every document in a collection. Firestore has
 * no TRUNCATE; batches keep this within the 500-writes-per-batch limit. */
export async function deleteCollection(db: Firestore, collectionName: string): Promise<void> {
  const snap = await db.collection(collectionName).get();
  if (snap.empty) return;
  const chunks: FirebaseFirestore.QueryDocumentSnapshot[][] = [];
  for (let i = 0; i < snap.docs.length; i += 500) {
    chunks.push(snap.docs.slice(i, i + 500));
  }
  for (const chunk of chunks) {
    const batch = db.batch();
    for (const doc of chunk) batch.delete(doc.ref);
    await batch.commit();
  }
}
