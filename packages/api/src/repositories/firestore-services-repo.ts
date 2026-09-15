import type { Firestore } from 'firebase-admin/firestore';
import type { CreateServiceInput, ServiceRecord, ServicesRepository } from './services-repo.js';
import { getFirestoreDb, closeFirestoreClient } from './firestore-client.js';
import { deleteCollection } from './firestore-appointments-repo.js';

const SERVICES_COLLECTION = 'services';

/** Firestore-backed ServicesRepository -- same selection rule and
 * database as FirestoreAppointmentsRepository (see index.ts). Doc id is
 * the service's own id, matching the Pg implementation's primary key so a
 * caller-supplied `id` (see services-repo.ts's CreateServiceInput comment
 * about seeding stable, known ids for the demo account) behaves the same
 * way under either backend. */
export class FirestoreServicesRepository implements ServicesRepository {
  private db: Firestore;

  constructor(projectId: string) {
    this.db = getFirestoreDb(projectId);
  }

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
    await this.db.collection(SERVICES_COLLECTION).doc(input.id).set(record);
    return record;
  }

  async getById(id: string): Promise<ServiceRecord | null> {
    const snap = await this.db.collection(SERVICES_COLLECTION).doc(id).get();
    return snap.exists ? (snap.data() as ServiceRecord) : null;
  }

  async listByAccount(accountId: string): Promise<ServiceRecord[]> {
    const snap = await this.db
      .collection(SERVICES_COLLECTION)
      .where('accountId', '==', accountId)
      .get();
    return snap.docs
      .map((d) => d.data() as ServiceRecord)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async reset(): Promise<void> {
    await deleteCollection(this.db, SERVICES_COLLECTION);
  }

  async close(): Promise<void> {
    await closeFirestoreClient();
  }
}
