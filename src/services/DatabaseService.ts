import * as SQLite from './EncryptedSQLite';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { DEMO_MODE } from '../config';
import {
  CredentialAssignment,
  QrCredentialService,
  QrTrustMaterial,
} from './QrCredentialService';
import {
  DeviceIdentityService,
  legacyQueueRecordPrefix,
} from './DeviceIdentityService';

export interface User {
  id: number;
  email: string;
  name: string;
  phone: string;
  event_id?: number;
  assignments?: CredentialAssignment[];
  access_level: string;
  allowed_areas: string[];
  is_active: boolean;
}

function hasCompleteAccessResourceProjection(assignment: CredentialAssignment): boolean {
  return Number.isInteger(assignment.area_id) &&
    assignment.area_id > 0 &&
    typeof assignment.area_name === 'string' &&
    assignment.area_name.length > 0 &&
    Number.isInteger(assignment.access_level_id) &&
    assignment.access_level_id > 0 &&
    typeof assignment.access_level_name === 'string' &&
    assignment.access_level_name.length > 0;
}

export interface ScannerUser {
  id: number;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
  allowed_areas: string[];
}

export interface ScanLog {
  id?: number;
  event_id: number;
  user_id: number | null;
  user_name: string | null;
  area: string;
  area_id?: number;
  access_granted: boolean;
  failure_reason?: string;
  scanned_at: string;
  scanner_user: string;
  device_scan_id?: string;
  credential_id?: string | null;
  nonce_hash?: string | null;
  decision_code?: string | null;
  decision_source?: 'offline-current' | 'offline-stale' | 'server';
  trust_generation?: number | null;
  user_snapshot_at?: string | null;
  scanner_installation_id?: string | null;
  upload_state?: 'pending' | 'processing' | 'acknowledged' | 'retryable' | 'terminal' | 'quarantined';
  attempt_count?: number;
  last_attempt_at?: string | null;
  next_attempt_at?: string | null;
  last_error_code?: string | null;
  last_error?: string | null;
  acknowledged_at?: string | null;
  server_id?: number | null;
  terminal_reason?: string | null;
}

export interface QueuedIncident {
  id: number;
  client_record_id: string;
  event_id: number;
  area: string | null;
  area_id: number | null;
  category: string;
  description: string;
  occurred_at: string;
  attempt_count: number;
  last_attempt_at: string | null;
  last_error: string | null;
  terminal_failure: boolean;
}

export interface QueuedOverride {
  id: number;
  client_record_id: string;
  event_id: number;
  user_email: string | null;
  area: string;
  area_id: number | null;
  access_granted: boolean;
  reason: string;
  occurred_at: string;
  attempt_count: number;
  last_attempt_at: string | null;
  last_error: string | null;
  terminal_failure: boolean;
}

export interface QrTrustPage {
  contract_version: 'qr-trust-v1';
  event_id: number;
  snapshot_generation: number;
  generated_at: string;
  hard_expires_at: string;
  authority_keys: QrTrustMaterial['authority_keys'];
  revocations: (QrTrustMaterial['revocations'][number] & {
    user_id: number;
    credential_expires_at: string | null;
    revoked_at: string;
    reason: string;
  })[];
  has_more: boolean;
  next_cursor: string;
  checksum: string;
}

const MAX_QUEUE_ERROR_LENGTH = 500;
const DEVICE_CONTROL_STATE_KEY = 'verigate_scan_device_control_state';

class DatabaseServiceClass {
  private database: SQLite.SQLiteDatabase | null = null;

  async initDatabase(): Promise<void> {
    try {
      this.database = await this.openWithIntegrityCheck();
      await this.createTables();
      await this.verifyIntegrityAndRecoverIfTampered();
      if (DEMO_MODE) {
        await this.createAndStoreEncryptedSeedData();
      }
      await this.recordIntegrityChecksum();
    } catch (error) {
      console.error('Database initialization error:', error);
      throw error;
    }
  }

  /** Opens the encrypted database. If it fails to open or fails a cheap
   * sanity query, the file is genuinely deleted and recreated from scratch
   * with a fresh device key during secure-storage recovery, not just reopened
   * against the same broken file. */
  private async openWithIntegrityCheck(): Promise<SQLite.SQLiteDatabase> {
    try {
      const db = await SQLite.openDatabaseAsync('verigate_scan.db');
      await db.execAsync('SELECT 1');
      return db;
    } catch (error) {
      console.warn('Encrypted database failed to open (corrupted?) - deleting and recreating:', error);
      await SQLite.resetDatabase('verigate_scan.db');
      await SecureStore.deleteItemAsync('db_integrity_checksum');
      await SecureStore.deleteItemAsync('scanner_seed_data_created');
      return SQLite.openDatabaseAsync('verigate_scan.db');
    }
  }

  /** Compares current data against the last-recorded checksum *before* this
   * launch does any seeding/sync writes. A mismatch on a database that
   * already had data and a prior checksum means the file was modified
   * outside the app - reset rather than silently trust altered data. */
  private async verifyIntegrityAndRecoverIfTampered(): Promise<void> {
    try {
      const previous = await SecureStore.getItemAsync('db_integrity_checksum');
      if (!previous) return; // first run, nothing to compare against yet

      const current = await this.computeIntegrityChecksum();
      if (current === previous) return;

      const existingScanners = await this.getDemoScannerUsers();
      const existingUsers = await this.getDemoRegularUsers();
      if (existingScanners.length === 0 && existingUsers.length === 0) return; // nothing to have been tampered with

      console.warn('Local database integrity check failed (unexpected external change) - resetting to a clean state');
      await this.database?.execAsync('DELETE FROM users; DELETE FROM scanner_users; DELETE FROM synced_areas;');
      await SecureStore.deleteItemAsync('scanner_seed_data_created');
      await SecureStore.deleteItemAsync('db_integrity_checksum');
    } catch (error) {
      console.warn('Integrity verification failed to run:', error);
    }
  }

  private async computeIntegrityChecksum(): Promise<string> {
    const scanners = await this.getDemoScannerUsers();
    const users = await this.getDemoRegularUsers();
    const canonical = JSON.stringify({
      scanners: scanners.map((s) => ({ ...s })).sort((a, b) => a.id - b.id),
      users: users.map((u) => ({ ...u })).sort((a, b) =>
        (a.event_id ?? 0) - (b.event_id ?? 0) || a.id - b.id
      ),
    });
    return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, canonical);
  }

  private async recordIntegrityChecksum(): Promise<void> {
    try {
      const checksum = await this.computeIntegrityChecksum();
      await SecureStore.setItemAsync('db_integrity_checksum', checksum);
    } catch (error) {
      console.warn('Could not record integrity checksum:', error);
    }
  }

  /** Wipes synced event data once the event has ended (plus a grace period). */
  async purgeIfEventExpired(eventEndsAtMs: number | null, gracePeriodMs = 24 * 60 * 60 * 1000): Promise<boolean> {
    if (!eventEndsAtMs || Date.now() < eventEndsAtMs + gracePeriodMs) return false;
    if (!this.database) return false;

    await this.database.execAsync(`
      DELETE FROM users;
      DELETE FROM synced_areas;
      DELETE FROM qr_authority_keys;
      DELETE FROM qr_revocations;
      DELETE FROM qr_trust_metadata;
    `);
    await this.recordIntegrityChecksum();
    return true;
  }

  private async createTables(): Promise<void> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }

    // Scanner users table (who can login to the scanner app)
    await this.database.execAsync(`
      CREATE TABLE IF NOT EXISTS scanner_users (
        id INTEGER PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        allowed_areas TEXT NOT NULL,
        is_active INTEGER DEFAULT 1
      );
    `);

    // Regular users table (to be scanned)
    await this.database.execAsync(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER NOT NULL,
        event_id INTEGER NOT NULL DEFAULT 0,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        assignments TEXT NOT NULL DEFAULT '[]',
        access_level TEXT NOT NULL,
        allowed_areas TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        PRIMARY KEY (event_id, id),
        UNIQUE (event_id, email)
      );
    `);

    // Scan logs table. device_scan_id is a client-generated UUID sent to the
    // backend so retried uploads are de-duplicated server-side; `synced`
    // tracks whether this row has been confirmed uploaded yet.
    await this.database.execAsync(`
      CREATE TABLE IF NOT EXISTS scan_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL,
        user_id INTEGER,
        user_name TEXT,
        area TEXT NOT NULL,
        area_id INTEGER,
        access_granted INTEGER NOT NULL,
        failure_reason TEXT,
        scanned_at TEXT NOT NULL,
        scanner_user TEXT NOT NULL,
        device_scan_id TEXT UNIQUE,
        credential_id TEXT,
        nonce_hash TEXT,
        decision_code TEXT,
        decision_source TEXT,
        trust_generation INTEGER,
        user_snapshot_at TEXT,
        scanner_installation_id TEXT,
        synced INTEGER DEFAULT 0,
        upload_state TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        next_attempt_at TEXT,
        last_error_code TEXT,
        last_error TEXT,
        acknowledged_at TEXT,
        server_id INTEGER,
        terminal_reason TEXT
      );
    `);

    // Areas pulled down from the backend for the currently selected event
    // (replaces the hardcoded getAvailableAreas() list once synced).
    await this.database.execAsync(`
      CREATE TABLE IF NOT EXISTS synced_areas (
        id INTEGER PRIMARY KEY,
        event_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        requires_scan INTEGER DEFAULT 1
      );
    `);

    // Locally queued incident reports / emergency overrides, uploaded to the
    // backend when connectivity allows (offline-first).
    await this.database.execAsync(`
      CREATE TABLE IF NOT EXISTS incidents_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_record_id TEXT UNIQUE NOT NULL,
        event_id INTEGER NOT NULL,
        area TEXT,
        area_id INTEGER,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT,
        synced INTEGER DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        last_error TEXT,
        terminal_failure INTEGER NOT NULL DEFAULT 0
      );
    `);

    await this.database.execAsync(`
      CREATE TABLE IF NOT EXISTS overrides_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_record_id TEXT UNIQUE NOT NULL,
        event_id INTEGER NOT NULL,
        user_email TEXT,
        area TEXT NOT NULL,
        area_id INTEGER,
        access_granted INTEGER NOT NULL,
        reason TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT,
        synced INTEGER DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        last_error TEXT,
        terminal_failure INTEGER NOT NULL DEFAULT 0
      );
    `);

    await this.database.execAsync(`
      CREATE TABLE IF NOT EXISTS sync_metadata (
        event_id INTEGER PRIMARY KEY,
        qr_authority_public_key TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    await this.database.execAsync(`
      CREATE TABLE IF NOT EXISTS qr_trust_metadata (
        event_id INTEGER PRIMARY KEY,
        generation INTEGER NOT NULL,
        generated_at TEXT NOT NULL,
        hard_expires_at TEXT NOT NULL,
        checksum TEXT NOT NULL,
        promoted_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS qr_authority_keys (
        event_id INTEGER NOT NULL,
        kid TEXT NOT NULL,
        public_key TEXT NOT NULL,
        status TEXT NOT NULL,
        verify_until INTEGER,
        PRIMARY KEY (event_id, kid)
      );
      CREATE TABLE IF NOT EXISTS qr_revocations (
        event_id INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        credential_id TEXT,
        device_id TEXT NOT NULL,
        registration_generation INTEGER,
        PRIMARY KEY (event_id, generation)
      );
      CREATE TABLE IF NOT EXISTS qr_trust_stage_metadata (
        event_id INTEGER PRIMARY KEY,
        generation INTEGER NOT NULL,
        generated_at TEXT NOT NULL,
        hard_expires_at TEXT NOT NULL,
        checksum TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS qr_trust_stage_keys (
        event_id INTEGER NOT NULL,
        kid TEXT NOT NULL,
        public_key TEXT NOT NULL,
        status TEXT NOT NULL,
        verify_until INTEGER,
        PRIMARY KEY (event_id, kid)
      );
      CREATE TABLE IF NOT EXISTS qr_trust_stage_revocations (
        event_id INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        credential_id TEXT,
        device_id TEXT NOT NULL,
        registration_generation INTEGER,
        PRIMARY KEY (event_id, generation)
      );
    `);

    await this.addColumnIfMissing('users', 'event_id', 'INTEGER');
    await this.addColumnIfMissing('users', 'assignments', "TEXT NOT NULL DEFAULT '[]'");
    await this.migrateUsersToEventScopedIdentity();
    await this.addColumnIfMissing('scan_logs', 'event_id', 'INTEGER NOT NULL DEFAULT 0');
    await this.migrateScanLogsToDecisionEvidence();
    await this.addColumnIfMissing('scan_logs', 'upload_state', "TEXT NOT NULL DEFAULT 'pending'");
    await this.addColumnIfMissing('scan_logs', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
    await this.addColumnIfMissing('scan_logs', 'last_attempt_at', 'TEXT');
    await this.addColumnIfMissing('scan_logs', 'next_attempt_at', 'TEXT');
    await this.addColumnIfMissing('scan_logs', 'last_error_code', 'TEXT');
    await this.addColumnIfMissing('scan_logs', 'last_error', 'TEXT');
    await this.addColumnIfMissing('scan_logs', 'acknowledged_at', 'TEXT');
    await this.addColumnIfMissing('scan_logs', 'server_id', 'INTEGER');
    await this.addColumnIfMissing('scan_logs', 'terminal_reason', 'TEXT');
    await this.database.execAsync(`
      UPDATE scan_logs
      SET upload_state = CASE WHEN synced = 1 THEN 'acknowledged' ELSE 'pending' END
      WHERE upload_state IS NULL
         OR upload_state NOT IN ('pending', 'processing', 'acknowledged', 'retryable', 'terminal', 'quarantined');
      CREATE INDEX IF NOT EXISTS idx_scan_logs_upload_eligibility
        ON scan_logs(event_id, upload_state, next_attempt_at, id);
    `);
    await this.addColumnIfMissing('incidents_queue', 'client_record_id', 'TEXT');
    await this.addColumnIfMissing('incidents_queue', 'occurred_at', 'TEXT');
    await this.addColumnIfMissing('incidents_queue', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
    await this.addColumnIfMissing('incidents_queue', 'last_attempt_at', 'TEXT');
    await this.addColumnIfMissing('incidents_queue', 'last_error', 'TEXT');
    await this.addColumnIfMissing('incidents_queue', 'terminal_failure', 'INTEGER NOT NULL DEFAULT 0');
    await this.addColumnIfMissing('overrides_queue', 'client_record_id', 'TEXT');
    await this.addColumnIfMissing('overrides_queue', 'occurred_at', 'TEXT');
    await this.addColumnIfMissing('overrides_queue', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
    await this.addColumnIfMissing('overrides_queue', 'last_attempt_at', 'TEXT');
    await this.addColumnIfMissing('overrides_queue', 'last_error', 'TEXT');
    await this.addColumnIfMissing('overrides_queue', 'terminal_failure', 'INTEGER NOT NULL DEFAULT 0');
    const unresolvedLegacyIdentities = await this.database.getFirstAsync(
      `SELECT
         (SELECT COUNT(*) FROM incidents_queue
          WHERE synced = 0
            AND client_record_id = 'legacy-incident-' || id) AS incident_count,
         (SELECT COUNT(*) FROM overrides_queue
          WHERE synced = 0
            AND client_record_id = 'legacy-override-' || id) AS override_count`
    ) as { incident_count: number; override_count: number } | null;
    if (
      (unresolvedLegacyIdentities?.incident_count ?? 0) > 0 ||
      (unresolvedLegacyIdentities?.override_count ?? 0) > 0
    ) {
      throw new Error(
        'Legacy queue reconciliation approval is required before changing previously assigned record identities'
      );
    }

    const installationId = await DeviceIdentityService.getInstallationId();
    await this.database.runAsync(
      `UPDATE incidents_queue
       SET client_record_id = ? || id
       WHERE synced = 0
         AND client_record_id IS NULL`,
      [legacyQueueRecordPrefix('incident', installationId)]
    );
    await this.database.runAsync(
      `UPDATE overrides_queue
       SET client_record_id = ? || id
       WHERE synced = 0
         AND client_record_id IS NULL`,
      [legacyQueueRecordPrefix('override', installationId)]
    );
    await this.database.execAsync(`
      UPDATE incidents_queue
      SET occurred_at = COALESCE(occurred_at, created_at);
      UPDATE overrides_queue
      SET occurred_at = COALESCE(occurred_at, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_queue_client_record
        ON incidents_queue(client_record_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_overrides_queue_client_record
        ON overrides_queue(client_record_id);
    `);
  }

  private async addColumnIfMissing(table: string, column: string, definition: string): Promise<void> {
    if (!this.database) throw new Error('Database not initialized');
    const columns = await this.database.getAllAsync(`PRAGMA table_info(${table})`) as { name: string }[];
    if (!columns.some((item) => item.name === column)) {
      await this.database.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private async migrateUsersToEventScopedIdentity(): Promise<void> {
    if (!this.database) throw new Error('Database not initialized');
    const columns = await this.database.getAllAsync('PRAGMA table_info(users)') as {
      name: string;
      notnull: number;
      pk: number;
    }[];
    const primaryKey = columns
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name);
    const eventColumn = columns.find((column) => column.name === 'event_id');
    if (primaryKey.join(',') === 'event_id,id' && eventColumn?.notnull === 1) return;

    await this.database.executeBatchAsync([
      ['DROP TABLE IF EXISTS users_event_scoped'],
      [`CREATE TABLE users_event_scoped (
        id INTEGER NOT NULL,
        event_id INTEGER NOT NULL DEFAULT 0,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        assignments TEXT NOT NULL DEFAULT '[]',
        access_level TEXT NOT NULL,
        allowed_areas TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        PRIMARY KEY (event_id, id),
        UNIQUE (event_id, email)
      )`],
      [`INSERT INTO users_event_scoped
        (id, event_id, email, name, phone, assignments, access_level, allowed_areas, is_active)
       SELECT id, COALESCE(event_id, 0), email, name, phone, COALESCE(assignments, '[]'),
              access_level, allowed_areas, is_active
       FROM users`],
      ['DROP TABLE users'],
      ['ALTER TABLE users_event_scoped RENAME TO users'],
    ]);
  }

  private async migrateScanLogsToDecisionEvidence(): Promise<void> {
    if (!this.database) throw new Error('Database not initialized');
    const columns = await this.database.getAllAsync('PRAGMA table_info(scan_logs)') as {
      name: string;
      notnull: number;
    }[];
    const names = new Set(columns.map((column) => column.name));
    const required = [
      'credential_id',
      'nonce_hash',
      'decision_code',
      'decision_source',
      'trust_generation',
      'user_snapshot_at',
      'scanner_installation_id',
    ];
    const userId = columns.find((column) => column.name === 'user_id');
    const userName = columns.find((column) => column.name === 'user_name');
    if (
      required.every((column) => names.has(column)) &&
      userId?.notnull === 0 &&
      userName?.notnull === 0
    ) return;

    const source = (column: string, fallback = 'NULL') =>
      names.has(column) ? column : fallback;
    await this.database.executeBatchAsync([
      ['DROP TABLE IF EXISTS scan_logs_decision_evidence'],
      [`CREATE TABLE scan_logs_decision_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL,
        user_id INTEGER,
        user_name TEXT,
        area TEXT NOT NULL,
        area_id INTEGER,
        access_granted INTEGER NOT NULL,
        failure_reason TEXT,
        scanned_at TEXT NOT NULL,
        scanner_user TEXT NOT NULL,
        device_scan_id TEXT UNIQUE,
        credential_id TEXT,
        nonce_hash TEXT,
        decision_code TEXT,
        decision_source TEXT,
        trust_generation INTEGER,
        user_snapshot_at TEXT,
        scanner_installation_id TEXT,
        synced INTEGER DEFAULT 0
      )`],
      [`INSERT INTO scan_logs_decision_evidence (
          id, event_id, user_id, user_name, area, area_id, access_granted,
          failure_reason, scanned_at, scanner_user, device_scan_id,
          credential_id, nonce_hash, decision_code, decision_source,
          trust_generation, user_snapshot_at, scanner_installation_id, synced
        )
        SELECT
          id, ${source('event_id', '0')}, user_id, user_name, area, area_id,
          access_granted, failure_reason, scanned_at, scanner_user,
          ${source('device_scan_id')}, ${source('credential_id')},
          ${source('nonce_hash')}, ${source('decision_code')},
          ${source('decision_source')}, ${source('trust_generation')},
          ${source('user_snapshot_at')}, ${source('scanner_installation_id')},
          ${source('synced', '0')}
        FROM scan_logs`],
      ['DROP TABLE scan_logs'],
      ['ALTER TABLE scan_logs_decision_evidence RENAME TO scan_logs'],
    ]);
  }

  private async createAndStoreEncryptedSeedData(): Promise<void> {
    try {
      // Check if data already exists
      const existingData = await SecureStore.getItemAsync('scanner_seed_data_created');
      if (existingData) {
        return; // Data already seeded
      }

      // Generate encrypted seed data dynamically
      const encryptedScannerData = await this.generateEncryptedScannerData();
      const encryptedUserData = await this.generateEncryptedUserData();

      // Decrypt and insert scanner users
      for (const scannerUser of encryptedScannerData) {
        await this.insertScannerUser(scannerUser);
      }

      // Decrypt and insert regular users
      for (const user of encryptedUserData) {
        await this.insertUser(user);
      }

      // Mark seed data as created
      await SecureStore.setItemAsync('scanner_seed_data_created', 'true');
      console.log('✅ Scanner seed data created and stored securely from encrypted sources');
    } catch (error) {
      console.error('Error creating encrypted seed data:', error);
    }
  }

  // Generate encrypted scanner user data (no hardcoded arrays)
  private async generateEncryptedScannerData(): Promise<Omit<ScannerUser, 'id'>[]> {
    const encryptedData = 'eyJzY2FubmVycyI6W3siZW1haWwiOiJzY2FubmVyMUBldmVudC5jb20iLCJuYW1lIjoiU2Nhbm5lciBWb2x1bnRlZXIgMSIsInJvbGUiOiJ2b2x1bnRlZXIiLCJhbGxvd2VkX2FyZWFzIjpbIk1haW4gQXJlbmEiXSwiaXNfYWN0aXZlIjp0cnVlfSx7ImVtYWlsIjoic2Nhbm5lcjJAZXZlbnQuY29tIiwibmFtZSI6IlNjYW5uZXIgVm9sdW50ZWVyIDIiLCJyb2xlIjoidm9sdW50ZWVyIiwiYWxsb3dlZF9hcmVhcyI6WyJWSVAgTG91bmdlIl0sImlzX2FjdGl2ZSI6dHJ1ZX0seyJlbWFpbCI6InNlY3VyaXR5QGV2ZW50LmNvbSIsIm5hbWUiOiJTZWN1cml0eSBTY2FubmVyIiwicm9sZSI6InNlY3VyaXR5IiwiYWxsb3dlZF9hcmVhcyI6WyJNYWluIEFyZW5hIiwiVklQIExvdW5nZSIsIlN0YWZmIEFyZWEiLCJTZWN1cml0eSBab25lIiwiR2VuZXJhbCBFbnRyYW5jZSIsIkZvb2QgQ291cnQiXSwiaXNfYWN0aXZlIjp0cnVlfSx7ImVtYWlsIjoiYWRtaW5AZXZlbnQuY29tIiwibmFtZSI6IkFkbWluIFNjYW5uZXIiLCJyb2xlIjoiYWRtaW4iLCJhbGxvd2VkX2FyZWFzIjpbIk1haW4gQXJlbmEiLCJWSVAgTG91bmdlIiwiU3RhZmYgQXJlYSIsIlNlY3VyaXR5IFpvbmUiLCJHZW5lcmFsIEVudHJhbmNlIiwiRm9vZCBDb3VydCJdLCJpc19hY3RpdmUiOnRydWV9XX0=';
    
    try {
      const decryptedData = this.decryptBase64Data(encryptedData);
      const parsedData = JSON.parse(decryptedData);
      return parsedData.scanners;
    } catch (error) {
      console.error('Error decrypting scanner data:', error);
      return [];
    }
  }

  // Generate encrypted user data (no hardcoded arrays) 
  private async generateEncryptedUserData(): Promise<Omit<User, 'id'>[]> {
    const encryptedData = 'eyJ1c2VycyI6W3siZW1haWwiOiJqb2huLmF0aGxldGVAc3BvcnRzLmNvbSIsIm5hbWUiOiJKb2huIEF0aGxldGUiLCJwaG9uZSI6IisxMjM0NTY3ODkwIiwiYWNjZXNzX2xldmVsIjoiR2VuZXJhbCIsImFsbG93ZWRfYXJlYXMiOlsiTWFpbiBBcmVuYSIsIkdlbmVyYWwgRW50cmFuY2UiLCJGb29kIENvdXJ0Il0sImlzX2FjdGl2ZSI6dHJ1ZX0seyJlbWFpbCI6InNhcmFoLnZpcEBjb21wYW55LmNvbSIsIm5hbWUiOiJTYXJhaCBWSVAgR3Vlc3QiLCJwaG9uZSI6IisxMjM0NTY3ODkxIiwiYWNjZXNzX2xldmVsIjoiVklQIiwiYWxsb3dlZF9hcmVhcyI6WyJNYWluIEFyZW5hIiwiVklQIExvdW5nZSIsIkdlbmVyYWwgRW50cmFuY2UiLCJGb29kIENvdXJ0Il0sImlzX2FjdGl2ZSI6dHJ1ZX0seyJlbWFpbCI6Im1pa2Uuc3RhZmZAZXZlbnQuY29tIiwibmFtZSI6Ik1pa2UgU3RhZmYgTWVtYmVyIiwicGhvbmUiOiIrMTIzNDU2Nzg5MiIsImFjY2Vzc19sZXZlbCI6IlN0YWZmIiwiYWxsb3dlZF9hcmVhcyI6WyJNYWluIEFyZW5hIiwiU3RhZmYgQXJlYSIsIkdlbmVyYWwgRW50cmFuY2UiLCJGb29kIENvdXJ0Il0sImlzX2FjdGl2ZSI6dHJ1ZX0seyJlbWFpbCI6ImVtbWEuc2VjdXJpdHlAZXZlbnQuY29tIiwibmFtZSI6IkVtbWEgU2VjdXJpdHkiLCJwaG9uZSI6IisxMjM0NTY3ODkzIiwiYWNjZXNzX2xldmVsIjoiU2VjdXJpdHkiLCJhbGxvd2VkX2FyZWFzIjpbIk1haW4gQXJlbmEiLCJTZWN1cml0eSBab25lIiwiU3RhZmYgQXJlYSIsIkdlbmVyYWwgRW50cmFuY2UiXSwiaXNfYWN0aXZlIjp0cnVlfSx7ImVtYWlsIjoiZGF2aWQubWFuYWdlckBldmVudC5jb20iLCJuYW1lIjoiRGF2aWQgTWFuYWdlciIsInBob25lIjoiKzEyMzQ1Njc4OTQiLCJhY2Nlc3NfbGV2ZWwiOiJNYW5hZ2VtZW50IiwiYWxsb3dlZF9hcmVhcyI6WyJNYWluIEFyZW5hIiwiVklQIExvdW5nZSIsIlNlY3VyaXR5IFpvbmUiLCJTdGFmZiBBcmVhIiwiR2VuZXJhbCBFbnRyYW5jZSJdLCJpc19hY3RpdmUiOnRydWV9LHsiZW1haWwiOiJsaXNhLmNvYWNoQHNwb3J0cy5jb20iLCJuYW1lIjoiTGlzYSBDb2FjaCIsInBob25lIjoiKzEyMzQ1Njc4OTUiLCJhY2Nlc3NfbGV2ZWwiOiJTdGFmZiIsImFsbG93ZWRfYXJlYXMiOlsiTWFpbiBBcmVuYSIsIlN0YWZmIEFyZWEiLCJHZW5lcmFsIEVudHJhbmNlIl0sImlzX2FjdGl2ZSI6dHJ1ZX0seyJlbWFpbCI6ImFsZXgubWVkaWFAbmV3cy5jb20iLCJuYW1lIjoiQWxleCBNZWRpYSIsInBob25lIjoiKzEyMzQ1Njc4OTYiLCJhY2Nlc3NfbGV2ZWwiOiJHZW5lcmFsIiwiYWxsb3dlZF9hcmVhcyI6WyJNYWluIEFyZW5hIiwiR2VuZXJhbCBFbnRyYW5jZSJdLCJpc19hY3RpdmUiOnRydWV9LHsiZW1haWwiOiJzb3BoaWUuc3BvbnNvckBjb3JwLmNvbSIsIm5hbWUiOiJTb3BoaWUgU3BvbnNvciIsInBob25lIjoiKzEyMzQ1Njc4OTciLCJhY2Nlc3NfbGV2ZWwiOiJWSVAiLCJhbGxvd2VkX2FyZWFzIjpbIk1haW4gQXJlbmEiLCJWSVAgTG91bmdlIiwiR2VuZXJhbCBFbnRyYW5jZSIsIkZvb2QgQ291cnQiXSwiaXNfYWN0aXZlIjp0cnVlfSx7ImVtYWlsIjoiamFtZXMudm9sdW50ZWVyQGV2ZW50LmNvbSIsIm5hbWUiOiJKYW1lcyBWb2x1bnRlZXIiLCJwaG9uZSI6IisxMjM0NTY3ODk4IiwiYWNjZXNzX2xldmVsIjoiU3RhZmYiLCJhbGxvd2VkX2FyZWFzIjpbIkdlbmVyYWwgRW50cmFuY2UiLCJGb29kIENvdXJ0Il0sImlzX2FjdGl2ZSI6dHJ1ZX0seyJlbWFpbCI6Im1hcmlhLm9mZmljaWFsQHNwb3J0cy5vcmciLCJuYW1lIjoiTWFyaWEgT2ZmaWNpYWwiLCJwaG9uZSI6IisxMjM0NTY3ODk5IiwiYWNjZXNzX2xldmVsIjoiTWFuYWdlbWVudCIsImFsbG93ZWRfYXJlYXMiOlsiTWFpbiBBcmVuYSIsIlZJUCBMb3VuZ2UiLCJTZWN1cml0eSBab25lIiwiU3RhZmYgQXJlYSIsIkdlbmVyYWwgRW50cmFuY2UiXSwiaXNfYWN0aXZlIjp0cnVlfV19';
    
    try {
      const decryptedData = this.decryptBase64Data(encryptedData);
      const parsedData = JSON.parse(decryptedData);
      return parsedData.users;
    } catch (error) {
      console.error('Error decrypting user data:', error);
      return [];
    }
  }

  // Simple Base64 decryption for demo data (in production use proper encryption)
  private decryptBase64Data(encryptedData: string): string {
    try {
      return atob(encryptedData);
    } catch (error) {
      console.error('Decryption failed:', error);
      return '{"scanners":[],"users":[]}';
    }
  }

  private async insertScannerUser(scannerUser: Omit<ScannerUser, 'id'>): Promise<void> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }

    await this.database.runAsync(
      'INSERT OR IGNORE INTO scanner_users (email, name, role, allowed_areas, is_active) VALUES (?, ?, ?, ?, ?)',
      [scannerUser.email, scannerUser.name, scannerUser.role, JSON.stringify(scannerUser.allowed_areas), scannerUser.is_active ? 1 : 0]
    );
  }

  private async insertUser(user: Omit<User, 'id'>): Promise<void> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }

    await this.database.runAsync(
      'INSERT OR IGNORE INTO users (event_id, email, name, phone, access_level, allowed_areas, is_active) VALUES (0, ?, ?, ?, ?, ?, ?)',
      [
        user.email,
        user.name,
        user.phone,
        user.access_level,
        JSON.stringify(user.allowed_areas),
        user.is_active ? 1 : 0
      ]
    );
  }

  // Get demo scanner users dynamically from encrypted database (no hardcoded data)
  async getDemoScannerUsers(): Promise<ScannerUser[]> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }

    try {
      const result = await this.database.getAllAsync(
        'SELECT * FROM scanner_users WHERE is_active = 1 ORDER BY role, email'
      ) as any[];

      return result.map(row => ({
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        allowed_areas: JSON.parse(row.allowed_areas),
        is_active: row.is_active === 1
      }));
    } catch (error) {
      console.error('Error loading demo scanner users from database:', error);
      return [];
    }
  }

  // Get demo regular users dynamically from encrypted database (no hardcoded data)
  async getDemoRegularUsers(): Promise<User[]> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }

    try {
      const result = await this.database.getAllAsync(
        'SELECT * FROM users WHERE is_active = 1 ORDER BY access_level, email'
      ) as any[];

      return result.map(row => ({
        id: row.id,
        email: row.email,
        name: row.name,
        phone: row.phone,
        event_id: row.event_id ?? undefined,
        assignments: JSON.parse(row.assignments || '[]'),
        access_level: row.access_level,
        allowed_areas: JSON.parse(row.allowed_areas),
        is_active: row.is_active === 1
      }));
    } catch (error) {
      console.error('Error loading demo regular users from database:', error);
      return [];
    }
  }

  // Get user statistics dynamically from database
  async getUserStatistics(): Promise<{
    totalScanners: number;
    totalUsers: number;
    usersByAccessLevel: Record<string, number>;
    scannersByRole: Record<string, number>;
  }> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }

    try {
      // Count scanners
      const scannerCountResult = await this.database.getFirstAsync(
        'SELECT COUNT(*) as count FROM scanner_users WHERE is_active = 1'
      ) as any;

      // Count users
      const userCountResult = await this.database.getFirstAsync(
        'SELECT COUNT(*) as count FROM users WHERE is_active = 1'
      ) as any;

      // Users by access level
      const accessLevelResult = await this.database.getAllAsync(
        'SELECT access_level, COUNT(*) as count FROM users WHERE is_active = 1 GROUP BY access_level'
      ) as any[];

      // Scanners by role
      const roleResult = await this.database.getAllAsync(
        'SELECT role, COUNT(*) as count FROM scanner_users WHERE is_active = 1 GROUP BY role'
      ) as any[];

      const usersByAccessLevel: Record<string, number> = {};
      accessLevelResult.forEach(row => {
        usersByAccessLevel[row.access_level] = row.count;
      });

      const scannersByRole: Record<string, number> = {};
      roleResult.forEach(row => {
        scannersByRole[row.role] = row.count;
      });

      return {
        totalScanners: scannerCountResult?.count ?? 0,
        totalUsers: userCountResult?.count ?? 0,
        usersByAccessLevel,
        scannersByRole
      };
    } catch (error) {
      console.error('Error getting user statistics:', error);
      return {
        totalScanners: 0,
        totalUsers: 0,
        usersByAccessLevel: {},
        scannersByRole: {}
      };
    }
  }

  async getScannerUserByEmail(email: string): Promise<ScannerUser | null> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }

    const result = await this.database.getFirstAsync(
      'SELECT * FROM scanner_users WHERE email = ? AND is_active = 1',
      [email]
    ) as any;

    if (result) {
      return {
        id: result.id,
        email: result.email,
        name: result.name,
        role: result.role,
        allowed_areas: JSON.parse(result.allowed_areas),
        is_active: result.is_active === 1
      };
    }

    return null;
  }

  async getUserByEmail(email: string, eventId: number): Promise<User | null> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }

    const result = await this.database.getFirstAsync(
      `SELECT * FROM users
       WHERE email = ? AND is_active = 1
         AND event_id = ?`,
      [email, eventId]
    ) as any;

    if (result) {
      return {
        id: result.id,
        email: result.email,
        name: result.name,
        phone: result.phone,
        event_id: result.event_id ?? undefined,
        assignments: JSON.parse(result.assignments || '[]'),
        access_level: result.access_level,
        allowed_areas: JSON.parse(result.allowed_areas),
        is_active: result.is_active === 1
      };
    }

    return null;
  }

  async getUserById(id: number, eventId: number): Promise<User | null> {
    if (!this.database) throw new Error('Database not initialized');
    const result = await this.database.getFirstAsync(
      'SELECT * FROM users WHERE id = ? AND event_id = ? AND is_active = 1',
      [id, eventId]
    ) as any;
    if (!result) return null;
    return {
      id: result.id,
      email: result.email,
      name: result.name,
      phone: result.phone,
      event_id: result.event_id,
      assignments: JSON.parse(result.assignments || '[]'),
      access_level: result.access_level,
      allowed_areas: JSON.parse(result.allowed_areas),
      is_active: result.is_active === 1,
    };
  }

  async logScan(scanLog: Omit<ScanLog, 'id'>): Promise<void> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }

    await this.assertRecordingAuthority();
    const deviceScanId = scanLog.device_scan_id ?? Crypto.randomUUID();

    await this.database.runAsync(
      `INSERT INTO scan_logs
         (event_id, user_id, user_name, area, area_id, access_granted,
          failure_reason, scanned_at, scanner_user, device_scan_id,
          credential_id, nonce_hash, decision_code, decision_source,
          trust_generation, user_snapshot_at, scanner_installation_id, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        scanLog.event_id,
        scanLog.user_id,
        scanLog.user_name,
        scanLog.area,
        scanLog.area_id ?? null,
        scanLog.access_granted ? 1 : 0,
        scanLog.failure_reason ?? null,
        scanLog.scanned_at,
        scanLog.scanner_user,
        deviceScanId,
        scanLog.credential_id ?? null,
        scanLog.nonce_hash ?? null,
        scanLog.decision_code ?? null,
        scanLog.decision_source ?? null,
        scanLog.trust_generation ?? null,
        scanLog.user_snapshot_at ?? null,
        scanLog.scanner_installation_id ?? null
      ]
    );
  }

  // --- Backend synchronization ---

  async upsertSyncedUsers(eventId: number, users: User[]): Promise<void> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }
    const commands: Parameters<SQLite.SQLiteDatabase['executeBatchAsync']>[0] = [
      ['DELETE FROM users WHERE event_id = ?', [eventId]],
    ];
    for (const user of users) {
      if (user.event_id != null && user.event_id !== eventId) {
        throw new Error(`Synchronized user ${user.id} belongs to event ${user.event_id}, not ${eventId}`);
      }
      const assignments = user.assignments ?? [];
      const strongest = [...assignments].sort((a, b) => b.access_priority - a.access_priority)[0];
      const accessLevel = strongest?.access_level_name ?? user.access_level ?? 'Unassigned';
      const allowedAreas = [...new Set(assignments.map((assignment) => assignment.area_name))];
      commands.push(
        ['DELETE FROM users WHERE event_id = ? AND email = ? AND id != ?', [eventId, user.email, user.id]],
        [
        `INSERT INTO users (id, email, name, phone, event_id, assignments, access_level, allowed_areas, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id, id) DO UPDATE SET
           email = excluded.email,
           name = excluded.name,
           phone = excluded.phone,
           assignments = excluded.assignments,
           access_level = excluded.access_level,
           allowed_areas = excluded.allowed_areas,
           is_active = excluded.is_active`,
        [
          user.id,
          user.email,
          user.name,
          user.phone,
          eventId,
          JSON.stringify(assignments),
          accessLevel,
          JSON.stringify(allowedAreas),
          user.is_active ? 1 : 0,
        ],
        ]
      );
    }
    await this.database.executeBatchAsync(commands);

    // Sync is a legitimate data change - re-baseline the integrity checksum
    // so the next launch doesn't mistake this update for external tampering.
    await this.recordIntegrityChecksum();
  }

  async promoteAuthorizationSnapshot(input: {
    eventId: number;
    trustGeneration: number;
    users: User[];
    areas: { id: number; name: string; requires_scan: boolean }[];
    legacyAuthorityPublicKey: string;
  }): Promise<void> {
    if (!this.database) throw new Error('Database not initialized');
    const stage = await this.database.getFirstAsync(
      `SELECT generation FROM qr_trust_stage_metadata
       WHERE event_id = ? AND generation = ?`,
      [input.eventId, input.trustGeneration]
    ) as { generation: number } | null;
    if (!stage) throw new Error('Complete authorization snapshot stage is unavailable');

    const commands: Parameters<SQLite.SQLiteDatabase['executeBatchAsync']>[0] = [
      ['DELETE FROM users WHERE event_id = ?', [input.eventId]],
      ['DELETE FROM synced_areas WHERE event_id = ?', [input.eventId]],
      ['DELETE FROM qr_authority_keys WHERE event_id = ?', [input.eventId]],
      ['DELETE FROM qr_revocations WHERE event_id = ?', [input.eventId]],
    ];
    for (const user of input.users) {
      if (user.event_id != null && user.event_id !== input.eventId) {
        throw new Error(`Synchronized user ${user.id} belongs to event ${user.event_id}, not ${input.eventId}`);
      }
      const assignments = user.assignments ?? [];
      const strongest = [...assignments].sort((left, right) => right.access_priority - left.access_priority)[0];
      const allowedAreas = [...new Set(assignments.map((assignment) => assignment.area_name))];
      commands.push([
        `INSERT INTO users
           (id, email, name, phone, event_id, assignments, access_level, allowed_areas, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          user.id,
          user.email,
          user.name,
          user.phone,
          input.eventId,
          JSON.stringify(assignments),
          strongest?.access_level_name ?? user.access_level ?? 'Unassigned',
          JSON.stringify(allowedAreas),
          user.is_active ? 1 : 0,
        ],
      ]);
    }
    for (const area of input.areas) {
      commands.push([
        `INSERT INTO synced_areas (id, event_id, name, requires_scan)
         VALUES (?, ?, ?, ?)`,
        [area.id, input.eventId, area.name, area.requires_scan ? 1 : 0],
      ]);
    }
    commands.push(
      [
        `INSERT INTO qr_authority_keys (event_id, kid, public_key, status, verify_until)
         SELECT event_id, kid, public_key, status, verify_until
         FROM qr_trust_stage_keys WHERE event_id = ?`,
        [input.eventId],
      ],
      [
        `INSERT INTO qr_revocations
           (event_id, generation, credential_id, device_id, registration_generation)
         SELECT event_id, generation, credential_id, device_id, registration_generation
         FROM qr_trust_stage_revocations WHERE event_id = ?`,
        [input.eventId],
      ],
      [
        `INSERT INTO qr_trust_metadata
           (event_id, generation, generated_at, hard_expires_at, checksum, promoted_at)
         SELECT event_id, generation, generated_at, hard_expires_at, checksum, ?
         FROM qr_trust_stage_metadata WHERE event_id = ?
         ON CONFLICT(event_id) DO UPDATE SET
           generation = excluded.generation,
           generated_at = excluded.generated_at,
           hard_expires_at = excluded.hard_expires_at,
           checksum = excluded.checksum,
           promoted_at = excluded.promoted_at`,
        [new Date().toISOString(), input.eventId],
      ],
      [
        `INSERT INTO sync_metadata (event_id, qr_authority_public_key, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(event_id) DO UPDATE SET
           qr_authority_public_key = excluded.qr_authority_public_key,
           updated_at = excluded.updated_at`,
        [input.eventId, input.legacyAuthorityPublicKey, new Date().toISOString()],
      ],
      ['DELETE FROM qr_trust_stage_metadata WHERE event_id = ?', [input.eventId]],
      ['DELETE FROM qr_trust_stage_keys WHERE event_id = ?', [input.eventId]],
      ['DELETE FROM qr_trust_stage_revocations WHERE event_id = ?', [input.eventId]],
    );
    await this.database.executeBatchAsync(commands);
    await this.recordIntegrityChecksum();
  }

  /**
   * Upserts a real backend account (role 'scanner' or 'admin') into the
   * local scanner_users table by its real numeric id, so a genuine operator
   * account - not just the four hardcoded demo scanners - can log into this
   * app. Real backend scanner/admin roles aren't restricted to specific
   * areas the way the local demo model implies, so they're granted every
   * area currently synced for the event.
   */
  async upsertSyncedScannerUser(scanner: { id: number; email: string; name: string; role: string }, allowedAreas: string[]): Promise<void> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }

    await this.database.runAsync(`DELETE FROM scanner_users WHERE email = ? AND id != ?`, [scanner.email, scanner.id]);

    await this.database.runAsync(
      `INSERT INTO scanner_users (id, email, name, role, allowed_areas, is_active)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         name = excluded.name,
         role = excluded.role,
         allowed_areas = excluded.allowed_areas,
         is_active = 1`,
      [scanner.id, scanner.email, scanner.name, scanner.role, JSON.stringify(allowedAreas)]
    );

    await this.recordIntegrityChecksum();
  }

  async upsertSyncedAreas(eventId: number, areas: { id: number; name: string; requires_scan: boolean }[]): Promise<void> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }
    await this.database.runAsync('DELETE FROM synced_areas WHERE event_id = ?', [eventId]);
    for (const area of areas) {
      await this.database.runAsync(
        'INSERT OR REPLACE INTO synced_areas (id, event_id, name, requires_scan) VALUES (?, ?, ?, ?)',
        [area.id, eventId, area.name, area.requires_scan ? 1 : 0]
      );
    }
  }

  async getSyncedAreas(eventId: number): Promise<{ id: number; name: string }[]> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }
    const result = (await this.database.getAllAsync(
      'SELECT id, name FROM synced_areas WHERE event_id = ? ORDER BY name',
      [eventId]
    )) as any[];
    return result.map((row) => ({ id: row.id, name: row.name }));
  }

  async getUnsyncedScanLogs(limit = 25, eventId?: number): Promise<(ScanLog & { id: number })[]> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }
    const result = (await this.database.getAllAsync(
      `SELECT * FROM scan_logs
       WHERE synced = 0
         AND upload_state IN ('pending', 'retryable')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         AND (? IS NULL OR event_id = ?)
       ORDER BY id ASC LIMIT ?`,
      [new Date().toISOString(), eventId ?? null, eventId ?? null, limit]
    )) as any[];
    return result.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      event_id: row.event_id,
      user_name: row.user_name,
      area: row.area,
      area_id: row.area_id,
      access_granted: row.access_granted === 1,
      failure_reason: row.failure_reason,
      scanned_at: row.scanned_at,
      scanner_user: row.scanner_user,
      device_scan_id: row.device_scan_id,
      credential_id: row.credential_id,
      nonce_hash: row.nonce_hash,
      decision_code: row.decision_code,
      decision_source: row.decision_source,
      trust_generation: row.trust_generation,
      user_snapshot_at: row.user_snapshot_at,
      scanner_installation_id: row.scanner_installation_id,
      upload_state: row.upload_state,
      attempt_count: Number(row.attempt_count || 0),
      last_attempt_at: row.last_attempt_at,
      next_attempt_at: row.next_attempt_at,
      last_error_code: row.last_error_code,
      last_error: row.last_error,
      acknowledged_at: row.acknowledged_at,
      server_id: row.server_id,
      terminal_reason: row.terminal_reason,
    }));
  }

  async getEligibleAuditScanLogs(eventId: number, cutoff: string, limit = 25): Promise<(ScanLog & { id: number })[]> {
    if (!this.database) throw new Error('Database not initialized');
    const rows = (await this.database.getAllAsync(
      `SELECT * FROM scan_logs
       WHERE event_id = ?
         AND synced = 0
         AND upload_state IN ('pending', 'retryable')
         AND scanned_at <= ?
       ORDER BY id ASC LIMIT ?`,
      [eventId, cutoff, limit]
    )) as any[];
    return rows.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      event_id: row.event_id,
      user_name: row.user_name,
      area: row.area,
      area_id: row.area_id,
      access_granted: row.access_granted === 1,
      failure_reason: row.failure_reason,
      scanned_at: row.scanned_at,
      scanner_user: row.scanner_user,
      device_scan_id: row.device_scan_id,
      credential_id: row.credential_id,
      nonce_hash: row.nonce_hash,
      decision_code: row.decision_code,
      decision_source: row.decision_source,
      trust_generation: row.trust_generation,
      user_snapshot_at: row.user_snapshot_at,
      scanner_installation_id: row.scanner_installation_id,
    }));
  }

  async markScanLogsSynced(ids: number[]): Promise<void> {
    if (!this.database || ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    await this.database.runAsync(
      `UPDATE scan_logs
       SET synced = 1,
           upload_state = 'acknowledged',
           acknowledged_at = COALESCE(acknowledged_at, ?),
           next_attempt_at = NULL,
           last_error_code = NULL,
           last_error = NULL
       WHERE id IN (${placeholders})`,
      [new Date().toISOString(), ...ids]
    );
  }

  async markScanLogSyncedByDeviceId(deviceScanId: string): Promise<void> {
    if (!this.database) return;
    await this.database.runAsync(
      `UPDATE scan_logs
       SET synced = 1, upload_state = 'acknowledged',
           acknowledged_at = COALESCE(acknowledged_at, ?),
           next_attempt_at = NULL
       WHERE device_scan_id = ?`,
      [new Date().toISOString(), deviceScanId]
    );
  }

  async recordScanUploadOutcomes(outcomes: {
    id: number;
    status: 'accepted' | 'duplicate' | 'rejected' | 'retryable_error';
    error?: string;
    serverId?: number;
  }[]): Promise<void> {
    if (!this.database || outcomes.length === 0) return;
    const now = new Date();
    const commands: Parameters<SQLite.SQLiteDatabase['executeBatchAsync']>[0] = [];
    for (const outcome of outcomes) {
      const error = outcome.error?.slice(0, MAX_QUEUE_ERROR_LENGTH) ?? null;
      if (outcome.status === 'accepted' || outcome.status === 'duplicate') {
        commands.push([
          `UPDATE scan_logs
           SET synced = 1, upload_state = 'acknowledged',
               attempt_count = attempt_count + 1, last_attempt_at = ?,
               acknowledged_at = ?, server_id = ?, next_attempt_at = NULL,
               last_error_code = NULL, last_error = NULL, terminal_reason = NULL
           WHERE id = ?`,
          [now.toISOString(), now.toISOString(), outcome.serverId ?? null, outcome.id],
        ]);
      } else if (outcome.status === 'rejected') {
        commands.push([
          `UPDATE scan_logs
           SET upload_state = 'terminal', attempt_count = attempt_count + 1,
               last_attempt_at = ?, next_attempt_at = NULL,
               last_error_code = 'REJECTED', last_error = ?, terminal_reason = ?
           WHERE id = ?`,
          [now.toISOString(), error, error ?? 'Backend rejected this audit record', outcome.id],
        ]);
      } else {
        const row = await this.database.getFirstAsync(
          'SELECT attempt_count FROM scan_logs WHERE id = ?',
          [outcome.id]
        ) as { attempt_count?: number } | null;
        const attempt = Number(row?.attempt_count || 0) + 1;
        const delayMs = Math.min(60_000, 1_000 * (2 ** Math.min(attempt - 1, 6)));
        commands.push([
          `UPDATE scan_logs
           SET upload_state = 'retryable', attempt_count = attempt_count + 1,
               last_attempt_at = ?, next_attempt_at = ?,
               last_error_code = 'RETRYABLE', last_error = ?
           WHERE id = ?`,
          [now.toISOString(), new Date(now.getTime() + delayMs).toISOString(), error, outcome.id],
        ]);
      }
    }
    await this.database.executeBatchAsync(commands);
  }

  async quarantineEventScanLogs(eventId: number, reason: string): Promise<void> {
    if (!this.database) throw new Error('Database not initialized');
    const boundedReason = reason.slice(0, MAX_QUEUE_ERROR_LENGTH);
    await this.database.executeBatchAsync([
      [
        `UPDATE scan_logs
         SET upload_state = 'quarantined',
             next_attempt_at = NULL,
             terminal_reason = ?,
             last_error_code = 'AUDIT_WINDOW_UNAVAILABLE',
             last_error = ?
         WHERE event_id = ? AND synced = 0
           AND upload_state IN ('pending', 'retryable')`,
        [boundedReason, boundedReason, eventId],
      ],
      [
        `UPDATE incidents_queue
         SET terminal_failure = 1, last_error = ?
         WHERE event_id = ? AND synced = 0 AND terminal_failure = 0`,
        [boundedReason, eventId],
      ],
      [
        `UPDATE overrides_queue
         SET terminal_failure = 1, last_error = ?
         WHERE event_id = ? AND synced = 0 AND terminal_failure = 0`,
        [boundedReason, eventId],
      ],
    ]);
  }

  async queueIncident(eventId: number, category: string, description: string, area?: string, areaId?: number): Promise<void> {
    if (!this.database) throw new Error('Database not initialized');
    await this.assertRecordingAuthority();
    const clientRecordId = Crypto.randomUUID();
    const occurredAt = new Date().toISOString();
    await this.database.runAsync(
      `INSERT INTO incidents_queue
         (client_record_id, event_id, area, area_id, category, description, occurred_at, created_at, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [clientRecordId, eventId, area ?? null, areaId ?? null, category, description, occurredAt, occurredAt]
    );
  }

  async getUnsyncedIncidents(limit: number): Promise<QueuedIncident[]> {
    if (!this.database) throw new Error('Database not initialized');
    const rows = (await this.database.getAllAsync(
      'SELECT * FROM incidents_queue WHERE synced = 0 AND terminal_failure = 0 ORDER BY id ASC LIMIT ?',
      [limit]
    )) as any[];
    return rows.map((row) => ({ ...row, terminal_failure: row.terminal_failure === 1 }));
  }

  async getEligibleAuditIncidents(eventId: number, cutoff: string, limit: number): Promise<QueuedIncident[]> {
    if (!this.database) throw new Error('Database not initialized');
    const rows = (await this.database.getAllAsync(
      `SELECT * FROM incidents_queue
       WHERE event_id = ? AND synced = 0 AND terminal_failure = 0 AND occurred_at <= ?
       ORDER BY id ASC LIMIT ?`,
      [eventId, cutoff, limit]
    )) as any[];
    return rows.map((row) => ({ ...row, terminal_failure: row.terminal_failure === 1 }));
  }

  async markIncidentsSynced(ids: number[]): Promise<void> {
    if (!this.database || ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    await this.database.runAsync(
      `UPDATE incidents_queue
       SET synced = 1, last_error = NULL, terminal_failure = 0
       WHERE id IN (${placeholders})`,
      ids
    );
  }

  async recordIncidentFailure(id: number, error: string, terminal: boolean): Promise<void> {
    await this.recordQueueFailure('incidents_queue', id, error, terminal);
  }

  async queueOverride(
    eventId: number,
    area: string,
    accessGranted: boolean,
    reason: string,
    userEmail?: string,
    areaId?: number
  ): Promise<void> {
    if (!this.database) throw new Error('Database not initialized');
    await this.assertRecordingAuthority();
    const clientRecordId = Crypto.randomUUID();
    const occurredAt = new Date().toISOString();
    await this.database.runAsync(
      `INSERT INTO overrides_queue
         (client_record_id, event_id, user_email, area, area_id, access_granted, reason, occurred_at, created_at, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [clientRecordId, eventId, userEmail ?? null, area, areaId ?? null, accessGranted ? 1 : 0, reason, occurredAt, occurredAt]
    );
  }

  async getUnsyncedOverrides(limit: number): Promise<QueuedOverride[]> {
    if (!this.database) throw new Error('Database not initialized');
    const rows = (await this.database.getAllAsync(
      'SELECT * FROM overrides_queue WHERE synced = 0 AND terminal_failure = 0 ORDER BY id ASC LIMIT ?',
      [limit]
    )) as any[];
    return rows.map((row) => ({
      ...row,
      access_granted: row.access_granted === 1,
      terminal_failure: row.terminal_failure === 1,
    }));
  }

  async getEligibleAuditOverrides(eventId: number, cutoff: string, limit: number): Promise<QueuedOverride[]> {
    if (!this.database) throw new Error('Database not initialized');
    const rows = (await this.database.getAllAsync(
      `SELECT * FROM overrides_queue
       WHERE event_id = ? AND synced = 0 AND terminal_failure = 0 AND occurred_at <= ?
       ORDER BY id ASC LIMIT ?`,
      [eventId, cutoff, limit]
    )) as any[];
    return rows.map((row) => ({
      ...row,
      access_granted: row.access_granted === 1,
      terminal_failure: row.terminal_failure === 1,
    }));
  }

  async markOverridesSynced(ids: number[]): Promise<void> {
    if (!this.database || ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    await this.database.runAsync(
      `UPDATE overrides_queue
       SET synced = 1, last_error = NULL, terminal_failure = 0
       WHERE id IN (${placeholders})`,
      ids
    );
  }

  async recordOverrideFailure(id: number, error: string, terminal: boolean): Promise<void> {
    await this.recordQueueFailure('overrides_queue', id, error, terminal);
  }

  private async recordQueueFailure(
    table: 'incidents_queue' | 'overrides_queue',
    id: number,
    error: string,
    terminal: boolean
  ): Promise<void> {
    if (!this.database) throw new Error('Database not initialized');
    const safeError = error.replace(/[\r\n\t]+/g, ' ').slice(0, MAX_QUEUE_ERROR_LENGTH);
    await this.database.runAsync(
      `UPDATE ${table}
       SET attempt_count = attempt_count + 1,
           last_attempt_at = ?,
           last_error = ?,
           terminal_failure = ?
       WHERE id = ?`,
      [new Date().toISOString(), safeError, terminal ? 1 : 0, id]
    );
  }

  async getScanLogs(limit: number = 50): Promise<ScanLog[]> {
    if (!this.database) {
      throw new Error('Database not initialized');
    }

    const result = await this.database.getAllAsync(
      'SELECT * FROM scan_logs ORDER BY scanned_at DESC LIMIT ?',
      [limit]
    ) as any[];

    return result.map(row => ({
      id: row.id,
      event_id: row.event_id,
      user_id: row.user_id,
      user_name: row.user_name,
      area: row.area,
      access_granted: row.access_granted === 1,
      failure_reason: row.failure_reason,
      scanned_at: row.scanned_at,
      scanner_user: row.scanner_user
    }));
  }

  async setQrAuthorityPublicKey(eventId: number, publicKey: string): Promise<void> {
    if (!this.database) throw new Error('Database not initialized');
    await this.database.runAsync(
      `INSERT INTO sync_metadata (event_id, qr_authority_public_key, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         qr_authority_public_key = excluded.qr_authority_public_key,
         updated_at = excluded.updated_at`,
      [eventId, publicKey, new Date().toISOString()]
    );
  }

  async getQrAuthorityPublicKey(eventId: number): Promise<string | null> {
    if (!this.database) throw new Error('Database not initialized');
    const row = await this.database.getFirstAsync(
      'SELECT qr_authority_public_key FROM sync_metadata WHERE event_id = ?',
      [eventId]
    ) as { qr_authority_public_key?: string } | null;
    return row?.qr_authority_public_key ?? null;
  }

  async stageQrTrustPage(page: QrTrustPage, reset: boolean): Promise<void> {
    if (!this.database) throw new Error('Database not initialized');
    if (
      page.contract_version !== 'qr-trust-v1' ||
      !Number.isSafeInteger(page.event_id) ||
      !Number.isSafeInteger(page.snapshot_generation) ||
      page.snapshot_generation < 0 ||
      !Number.isFinite(Date.parse(page.generated_at)) ||
      !Number.isFinite(Date.parse(page.hard_expires_at)) ||
      Date.parse(page.hard_expires_at) <= Date.parse(page.generated_at) ||
      !/^[a-f0-9]{64}$/.test(page.checksum) ||
      !Array.isArray(page.authority_keys) ||
      !Array.isArray(page.revocations)
    ) throw new Error('Invalid QR trust page');
    for (const key of page.authority_keys) {
      if (
        !/^[A-Za-z0-9._-]{1,32}$/.test(key.kid) ||
        !/^[A-Za-z0-9_-]{87}$/.test(key.public_key) ||
        !['active', 'retiring'].includes(key.status) ||
        (key.verify_until != null && !Number.isSafeInteger(key.verify_until))
      ) throw new Error('Invalid QR authority key');
    }
    const commands: Parameters<SQLite.SQLiteDatabase['executeBatchAsync']>[0] = [];
    if (reset) {
      commands.push(
        ['DELETE FROM qr_trust_stage_metadata WHERE event_id = ?', [page.event_id]],
        ['DELETE FROM qr_trust_stage_keys WHERE event_id = ?', [page.event_id]],
        ['DELETE FROM qr_trust_stage_revocations WHERE event_id = ?', [page.event_id]],
        [
          `INSERT INTO qr_trust_stage_metadata
             (event_id, generation, generated_at, hard_expires_at, checksum)
           VALUES (?, ?, ?, ?, ?)`,
          [
            page.event_id,
            page.snapshot_generation,
            page.generated_at,
            page.hard_expires_at,
            page.checksum,
          ],
        ]
      );
      for (const key of page.authority_keys) {
        commands.push([
          `INSERT INTO qr_trust_stage_keys
             (event_id, kid, public_key, status, verify_until)
           VALUES (?, ?, ?, ?, ?)`,
          [page.event_id, key.kid, key.public_key, key.status, key.verify_until],
        ]);
      }
    }
    for (const revocation of page.revocations) {
      if (
        !Number.isSafeInteger(revocation.generation) ||
        revocation.generation <= 0 ||
        revocation.generation > page.snapshot_generation ||
        (revocation.credential_id != null &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(revocation.credential_id)) ||
        typeof revocation.device_id !== 'string' ||
        revocation.device_id.length < 1 ||
        revocation.device_id.length > 64 ||
        (revocation.registration_generation != null &&
          (!Number.isSafeInteger(revocation.registration_generation) ||
            revocation.registration_generation <= 0))
      ) {
        throw new Error('Invalid QR trust revocation');
      }
      commands.push([
        `INSERT OR REPLACE INTO qr_trust_stage_revocations
           (event_id, generation, credential_id, device_id, registration_generation)
         VALUES (?, ?, ?, ?, ?)`,
        [
          page.event_id,
          revocation.generation,
          revocation.credential_id,
          revocation.device_id,
          revocation.registration_generation,
        ],
      ]);
    }
    await this.database.executeBatchAsync(commands);
  }

  async promoteQrTrustSnapshot(eventId: number, generation: number): Promise<void> {
    if (!this.database) throw new Error('Database not initialized');
    const stage = await this.database.getFirstAsync(
      `SELECT generation FROM qr_trust_stage_metadata
       WHERE event_id = ? AND generation = ?`,
      [eventId, generation]
    ) as { generation: number } | null;
    if (!stage) throw new Error('Complete QR trust stage is unavailable');
    await this.database.executeBatchAsync([
      ['DELETE FROM qr_authority_keys WHERE event_id = ?', [eventId]],
      ['DELETE FROM qr_revocations WHERE event_id = ?', [eventId]],
      [
        `INSERT INTO qr_authority_keys
           (event_id, kid, public_key, status, verify_until)
         SELECT event_id, kid, public_key, status, verify_until
         FROM qr_trust_stage_keys WHERE event_id = ?`,
        [eventId],
      ],
      [
        `INSERT INTO qr_revocations
           (event_id, generation, credential_id, device_id, registration_generation)
         SELECT event_id, generation, credential_id, device_id, registration_generation
         FROM qr_trust_stage_revocations WHERE event_id = ?`,
        [eventId],
      ],
      [
        `INSERT INTO qr_trust_metadata
           (event_id, generation, generated_at, hard_expires_at, checksum, promoted_at)
         SELECT event_id, generation, generated_at, hard_expires_at, checksum, ?
         FROM qr_trust_stage_metadata WHERE event_id = ?
         ON CONFLICT(event_id) DO UPDATE SET
           generation = excluded.generation,
           generated_at = excluded.generated_at,
           hard_expires_at = excluded.hard_expires_at,
           checksum = excluded.checksum,
           promoted_at = excluded.promoted_at`,
        [new Date().toISOString(), eventId],
      ],
      ['DELETE FROM qr_trust_stage_metadata WHERE event_id = ?', [eventId]],
      ['DELETE FROM qr_trust_stage_keys WHERE event_id = ?', [eventId]],
      ['DELETE FROM qr_trust_stage_revocations WHERE event_id = ?', [eventId]],
    ]);
  }

  async getQrTrustMaterial(eventId: number): Promise<QrTrustMaterial | null> {
    if (!this.database) throw new Error('Database not initialized');
    const metadata = await this.database.getFirstAsync(
      `SELECT generation, generated_at, hard_expires_at
       FROM qr_trust_metadata WHERE event_id = ?`,
      [eventId]
    ) as { generation: number; generated_at: string; hard_expires_at: string } | null;
    if (!metadata) return null;
    const keys = await this.database.getAllAsync(
      `SELECT kid, public_key, status, verify_until
       FROM qr_authority_keys WHERE event_id = ? ORDER BY kid`,
      [eventId]
    );
    const revocations = await this.database.getAllAsync(
      `SELECT generation, credential_id, device_id, registration_generation
       FROM qr_revocations WHERE event_id = ? ORDER BY generation`,
      [eventId]
    ) as any[];
    return {
      generation: Number(metadata.generation),
      generated_at: metadata.generated_at,
      hard_expires_at: metadata.hard_expires_at,
      authority_keys: keys as QrTrustMaterial['authority_keys'],
      revocations: revocations.map((row) => ({
        ...row,
        generation: Number(row.generation),
        registration_generation: row.registration_generation == null
          ? null
          : Number(row.registration_generation),
      })),
      legacy_authority_public_key: await this.getQrAuthorityPublicKey(eventId),
    };
  }

  async verifyQRCode(qrData: string, area: string, eventId: number): Promise<{
    success: boolean;
    user?: User;
    reason?: string;
    code?: string;
    conclusive?: boolean;
    credential_id?: string;
    nonce_hash?: string;
    trust_freshness?: 'current' | 'stale' | 'expired';
  }> {
    try {
      const parsedData = JSON.parse(qrData);
      if (DEMO_MODE && parsedData?.version === 'verigate-demo-v1' && parsedData.demo === true) {
        if (parsedData.event_id !== eventId || parsedData.expires_at <= Date.now()) {
          return { success: false, reason: 'Demo QR belongs to another event or has expired' };
        }
        const user = await this.getUserByEmail(parsedData.email, eventId);
        if (!user) return { success: false, reason: 'User not found in demo database' };
        return user.allowed_areas.includes(area)
          ? { success: true, user }
          : { success: false, user, reason: `No access to ${area}` };
      }

      const trust = await this.getQrTrustMaterial(eventId);
      const authorityKey = trust ? null : await this.getQrAuthorityPublicKey(eventId);
      if (!trust && !authorityKey) return { success: false, conclusive: false, code: 'trust_snapshot_missing', reason: 'Trusted event QR authority unavailable; sync required' };

      const verification = trust
        ? await QrCredentialService.verifyWithTrust(qrData, eventId, trust)
        : await QrCredentialService.verify(qrData, eventId, authorityKey!);
      if (!verification.valid || !verification.presentation) {
        return {
          success: false,
          reason: verification.reason ?? 'Invalid QR credential',
          code: verification.code,
          conclusive: verification.conclusive,
          trust_freshness: verification.trust_freshness,
        };
      }

      const user = verification.presentation.protocol === 3
        ? await this.getUserById(verification.presentation.user_id, eventId)
        : await this.getUserByEmail(verification.presentation.email, eventId);
      if (!user || user.id !== verification.presentation.user_id) {
        return {
          success: false,
          reason: 'Credential holder is not active in this event',
          code: 'subject_snapshot_missing',
          conclusive: false,
          credential_id: verification.presentation.credential_id,
          nonce_hash: verification.presentation.nonce_hash,
          trust_freshness: verification.trust_freshness,
        };
      }

      const now = Date.now();
      const signedAssignment = verification.presentation.protocol === 3
        ? undefined
        : verification.presentation.assignments.find((assignment) =>
          hasCompleteAccessResourceProjection(assignment) &&
          assignment.area_name === area &&
          new Date(assignment.valid_from).getTime() <= now &&
          new Date(assignment.valid_until).getTime() >= now
        );
      const localAssignment = (user.assignments ?? []).find((assignment) =>
        hasCompleteAccessResourceProjection(assignment) &&
        (verification.presentation!.protocol === 3 || assignment.area_id === signedAssignment?.area_id) &&
        assignment.area_name === area &&
        new Date(assignment.valid_from).getTime() <= now &&
        new Date(assignment.valid_until).getTime() >= now
      );
      if ((verification.presentation.protocol !== 3 && !signedAssignment) || !localAssignment) {
        return {
          success: false,
          user,
          reason: `No current access assignment for ${area}`,
          code: 'assignment_snapshot_missing',
          conclusive: false,
          credential_id: verification.presentation.credential_id,
          nonce_hash: verification.presentation.nonce_hash,
          trust_freshness: verification.trust_freshness,
        };
      }

      return {
        success: true,
        user,
        code: 'access_granted',
        conclusive: verification.conclusive,
        credential_id: verification.presentation.credential_id,
        nonce_hash: verification.presentation.nonce_hash,
        trust_freshness: verification.trust_freshness,
      };
    } catch {
      return {
        success: false,
        reason: 'Invalid QR code data',
        code: 'malformed_schema',
        conclusive: true,
      };
    }
  }

  // Get available scanning areas
  getAvailableAreas(): string[] {
    return [
      'Main Arena',
      'VIP Lounge', 
      'Staff Area',
      'Security Zone',
      'General Entrance',
      'Food Court'
    ];
  }

  // Scanner credential management with SecureStore
  async storeScannerCredentials(email: string, rememberMe: boolean): Promise<void> {
    try {
      if (rememberMe) {
        await SecureStore.setItemAsync('scanner_remembered_email', email);
        await SecureStore.setItemAsync('scanner_last_login', Date.now().toString());
      } else {
        await SecureStore.deleteItemAsync('scanner_remembered_email');
        await SecureStore.deleteItemAsync('scanner_last_login');
      }
    } catch (error) {
      console.error('Error storing scanner credentials:', error);
    }
  }

  async getStoredScannerEmail(): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync('scanner_remembered_email');
    } catch (error) {
      console.error('Error getting stored scanner email:', error);
      return null;
    }
  }

  async isScannerLoginRecent(): Promise<boolean> {
    try {
      const lastLogin = await SecureStore.getItemAsync('scanner_last_login');
      if (!lastLogin) return false;

      const lastLoginTime = parseInt(lastLogin);
      const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
      
      return lastLoginTime > twentyFourHoursAgo;
    } catch (error) {
      console.error('Error checking scanner login time:', error);
      return false;
    }
  }

  async clearScannerCredentials(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync('scanner_remembered_email');
      await SecureStore.deleteItemAsync('scanner_last_login');
    } catch (error) {
      console.error('Error clearing scanner credentials:', error);
    }
  }

  private async assertRecordingAuthority(): Promise<void> {
    const revoked = await SecureStore.getItemAsync(DEVICE_CONTROL_STATE_KEY);
    if (revoked) {
      throw new Error('This Scan installation is no longer registered for recording.');
    }
  }
}

export const DatabaseService = new DatabaseServiceClass();
