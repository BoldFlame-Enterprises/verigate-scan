import * as SecureStore from 'expo-secure-store';
import { DatabaseService } from './DatabaseService';
import { DeregisteredAuditSession, SyncService } from './SyncService';

const DEREGISTRATION_AUDIT_KEY = 'verigate_scan_deregistration_audit_v1';

export interface DeregistrationAuditStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

interface DeregistrationAuditDependencies {
  store: DeregistrationAuditStore;
  drain(session: DeregisteredAuditSession): Promise<{ uploaded: number }>;
  health(eventId: number): Promise<{ unresolved: number }>;
  quarantine(eventId: number, reason: string): Promise<void>;
  now(): number;
}

export interface AuditResumeOptions {
  maximumPasses?: number;
  foregroundBudgetMs?: number;
}

export type AuditResumeResult = {
  status: 'absent' | 'completed' | 'retrying' | 'expired';
  uploaded: number;
  unresolved: number;
};

const secureStore: DeregistrationAuditStore = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  deleteItem: (key) => SecureStore.deleteItemAsync(key),
};

const defaultDependencies: DeregistrationAuditDependencies = {
  store: secureStore,
  drain: (session) => SyncService.drainDeregisteredAuditQueues(session),
  health: (eventId) => DatabaseService.getQueueHealth(eventId),
  quarantine: (eventId, reason) => DatabaseService.quarantineEventQueues(eventId, reason),
  now: () => Date.now(),
};

function validateSession(session: DeregisteredAuditSession): void {
  if (!Number.isSafeInteger(session.eventId) || session.eventId <= 0) {
    throw new Error('Deregistration audit event is invalid');
  }
  if (!Number.isFinite(Date.parse(session.cutoff)) || !Number.isFinite(Date.parse(session.deadline))) {
    throw new Error('Deregistration audit window is invalid');
  }
  if (Date.parse(session.cutoff) > Date.parse(session.deadline)) {
    throw new Error('Deregistration audit cutoff exceeds its deadline');
  }
  if (!session.accessToken) throw new Error('Deregistration audit credential is missing');
}

export class DeregistrationAuditServiceClass {
  private inFlight: Promise<AuditResumeResult> | null = null;

  constructor(private readonly dependencies: DeregistrationAuditDependencies = defaultDependencies) {}

  async begin(session: DeregisteredAuditSession): Promise<void> {
    validateSession(session);
    await this.dependencies.store.setItem(DEREGISTRATION_AUDIT_KEY, JSON.stringify(session));
  }

  private async read(): Promise<DeregisteredAuditSession | null> {
    const stored = await this.dependencies.store.getItem(DEREGISTRATION_AUDIT_KEY);
    if (!stored) return null;
    try {
      const session = JSON.parse(stored) as DeregisteredAuditSession;
      validateSession(session);
      return session;
    } catch {
      await this.dependencies.store.deleteItem(DEREGISTRATION_AUDIT_KEY);
      return null;
    }
  }

  resume(options: AuditResumeOptions = {}): Promise<AuditResumeResult> {
    if (this.inFlight) return this.inFlight;
    const operation = this.performResume(options).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = operation;
    return operation;
  }

  private async performResume(options: AuditResumeOptions): Promise<AuditResumeResult> {
    const session = await this.read();
    if (!session) return { status: 'absent', uploaded: 0, unresolved: 0 };
    const maximumPasses = Math.max(1, Math.min(100, options.maximumPasses ?? 20));
    const foregroundBudgetMs = Math.max(100, Math.min(30_000, options.foregroundBudgetMs ?? 8_000));
    const startedAt = this.dependencies.now();
    let uploaded = 0;
    let health = await this.dependencies.health(session.eventId);

    if (this.dependencies.now() >= Date.parse(session.deadline)) {
      await this.dependencies.quarantine(
        session.eventId,
        'The deregistration audit upload window expired before all records were acknowledged.'
      );
      await this.dependencies.store.deleteItem(DEREGISTRATION_AUDIT_KEY);
      return { status: 'expired', uploaded, unresolved: health.unresolved };
    }

    for (let pass = 0; pass < maximumPasses; pass += 1) {
      if (health.unresolved === 0) {
        await this.dependencies.store.deleteItem(DEREGISTRATION_AUDIT_KEY);
        return { status: 'completed', uploaded, unresolved: 0 };
      }
      if (
        this.dependencies.now() >= Date.parse(session.deadline) ||
        this.dependencies.now() - startedAt >= foregroundBudgetMs
      ) break;

      const result = await this.dependencies.drain(session);
      uploaded += result.uploaded;
      health = await this.dependencies.health(session.eventId);
      if (result.uploaded === 0 && health.unresolved > 0) break;
    }

    if (health.unresolved === 0) {
      await this.dependencies.store.deleteItem(DEREGISTRATION_AUDIT_KEY);
      return { status: 'completed', uploaded, unresolved: 0 };
    }
    if (this.dependencies.now() >= Date.parse(session.deadline)) {
      await this.dependencies.quarantine(
        session.eventId,
        'The deregistration audit upload window expired before all records were acknowledged.'
      );
      await this.dependencies.store.deleteItem(DEREGISTRATION_AUDIT_KEY);
      return { status: 'expired', uploaded, unresolved: health.unresolved };
    }
    return { status: 'retrying', uploaded, unresolved: health.unresolved };
  }

  async cancelForBlacklist(): Promise<void> {
    const session = await this.read();
    if (session) {
      const health = await this.dependencies.health(session.eventId);
      if (health.unresolved > 0) {
        await this.dependencies.quarantine(
          session.eventId,
          'Audit upload authority was revoked because this installation was blacklisted.'
        );
      }
    }
    await this.dependencies.store.deleteItem(DEREGISTRATION_AUDIT_KEY);
  }
}

export const DeregistrationAuditService = new DeregistrationAuditServiceClass();
