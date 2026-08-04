/* eslint-disable import/first */
jest.mock('@op-engineering/op-sqlite', () => ({ open: jest.fn() }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: jest.fn(async () => 'checksum'),
  getRandomBytesAsync: jest.fn(async () => new Uint8Array(32)),
  randomUUID: jest.fn(() => 'record-id'),
}));
jest.mock('../../config', () => ({ DEMO_MODE: false }));
jest.mock('../QrCredentialService', () => ({
  QrCredentialService: { verify: jest.fn(), verifyWithTrust: jest.fn() },
}));

import * as SecureStore from 'expo-secure-store';
import { DatabaseService, User } from '../DatabaseService';
import { SQLiteDatabase } from '../EncryptedSQLite';
import { QrCredentialService } from '../QrCredentialService';

type DatabaseDouble = {
  execAsync: jest.Mock<Promise<void>, [string]>;
  runAsync: jest.Mock<Promise<{ lastInsertRowId: number; changes: number }>, [string, unknown[]?]>;
  executeBatchAsync: jest.Mock<Promise<void>, [([string] | [string, unknown[]])[]]>;
  getFirstAsync: jest.Mock<Promise<unknown>, [string, unknown[]?]>;
  getAllAsync: jest.Mock<Promise<unknown[]>, [string, unknown[]?]>;
};

type TestableDatabaseService = {
  database: DatabaseDouble | null;
  createTables(): Promise<void>;
  verifyNativeIntegrity(): Promise<unknown>;
};

const service = DatabaseService as unknown as TestableDatabaseService;
const compact = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function createDatabaseDouble(): DatabaseDouble {
  return {
    execAsync: jest.fn(async (_sql: string) => undefined),
    runAsync: jest.fn(async (_sql: string, _params?: unknown[]) => ({ lastInsertRowId: 0, changes: 0 })),
    executeBatchAsync: jest.fn(async (_commands: ([string] | [string, unknown[]])[]) => undefined),
    getFirstAsync: jest.fn(async (_sql: string, _params?: unknown[]) => null),
    getAllAsync: jest.fn(async (_sql: string, _params?: unknown[]) => []),
  };
}

function user(eventId: number): User {
  return {
    id: 5,
    event_id: eventId,
    email: 'same@example.com',
    name: `Event ${eventId}`,
    phone: '1',
    access_level: 'General',
    allowed_areas: [],
    assignments: [],
    is_active: true,
  };
}

describe('DatabaseService event-scoped users', () => {
  afterEach(() => {
    service.database = null;
    jest.clearAllMocks();
  });

  it('atomically migrates the legacy global identity schema without dropping rows', async () => {
    const database = createDatabaseDouble();
    database.getAllAsync.mockImplementation(async (sql) => {
      if (sql.includes('PRAGMA table_info(users)')) {
        return [
          { name: 'id', notnull: 0, pk: 1 },
          { name: 'email', notnull: 1, pk: 0 },
          { name: 'event_id', notnull: 0, pk: 0 },
          { name: 'assignments', notnull: 1, pk: 0 },
        ];
      }
      return [];
    });
    service.database = database;

    await service.createTables();

    expect(database.executeBatchAsync).toHaveBeenCalledTimes(2);
    const commands = database.executeBatchAsync.mock.calls[0][0];
    expect(compact(commands[1][0])).toContain('PRIMARY KEY (event_id, id)');
    expect(compact(commands[1][0])).toContain('UNIQUE (event_id, email)');
    expect(compact(commands[2][0])).toContain('SELECT id, COALESCE(event_id, 0)');
    expect(commands.map(([sql]) => compact(sql))).toEqual(expect.arrayContaining([
      'DROP TABLE users',
      'ALTER TABLE users_event_scoped RENAME TO users',
    ]));
    const scanCommands = database.executeBatchAsync.mock.calls[1][0];
    expect(compact(scanCommands[1][0])).toContain('user_id INTEGER, user_name TEXT');
    expect(compact(scanCommands[2][0])).toContain('credential_id, nonce_hash, decision_code');
    expect(scanCommands.map(([sql]) => compact(sql))).toEqual(expect.arrayContaining([
      'DROP TABLE scan_logs',
      'ALTER TABLE scan_logs_decision_evidence RENAME TO scan_logs',
    ]));
  });

  it('replaces only one event snapshot while retaining the same identity in another event', async () => {
    const database = createDatabaseDouble();
    service.database = database;

    await DatabaseService.upsertSyncedUsers(11, [user(11)]);
    await DatabaseService.upsertSyncedUsers(22, [user(22)]);

    const firstCommands = database.executeBatchAsync.mock.calls[0][0];
    const secondCommands = database.executeBatchAsync.mock.calls[1][0];
    expect(firstCommands[0]).toEqual(['DELETE FROM users WHERE event_id = ?', [11]]);
    expect(secondCommands[0]).toEqual(['DELETE FROM users WHERE event_id = ?', [22]]);
    expect(firstCommands[1]).toEqual([
      'DELETE FROM users WHERE event_id = ? AND email = ? AND id != ?',
      [11, 'same@example.com', 5],
    ]);
    expect(secondCommands[1][1]).toEqual([22, 'same@example.com', 5]);
    expect(compact(firstCommands[2][0])).toContain('ON CONFLICT(event_id, id) DO UPDATE SET');
    expect(firstCommands[2][1]?.slice(0, 5)).toEqual([5, 'same@example.com', 'Event 11', '1', 11]);
    expect(secondCommands[2][1]?.slice(0, 5)).toEqual([5, 'same@example.com', 'Event 22', '1', 22]);
  });

  it('requires the event identity when looking up a scanned attendee', async () => {
    const database = createDatabaseDouble();
    database.getFirstAsync.mockResolvedValue({
      ...user(22),
      allowed_areas: '[]',
      assignments: '[]',
      is_active: 1,
    });
    service.database = database;

    await expect(DatabaseService.getUserByEmail('same@example.com', 22)).resolves.toMatchObject({ event_id: 22 });

    expect(database.getFirstAsync).toHaveBeenCalledWith(
      expect.stringContaining('AND event_id = ?'),
      ['same@example.com', 22]
    );
  });

  it('aggregates event-scoped health across scan, incident, and override queues', async () => {
    const database = createDatabaseDouble();
    database.getFirstAsync
      .mockResolvedValueOnce({ pending: 2, retrying: 1, terminal: 1, quarantined: 1, acknowledged: 4 })
      .mockResolvedValueOnce({ pending: 3, retrying: 2, terminal: 1, quarantined: 0, acknowledged: 5 })
      .mockResolvedValueOnce({ pending: 1, retrying: 1, terminal: 2, quarantined: 1, acknowledged: 6 });
    service.database = database;

    await expect(DatabaseService.getQueueHealth(7)).resolves.toEqual({
      pending: 6,
      retrying: 4,
      terminal: 4,
      quarantined: 2,
      acknowledged: 15,
      unresolved: 16,
    });
    expect(database.getFirstAsync.mock.calls.every(([, params]) => params?.[0] === 7)).toBe(true);
  });

  it('uses native integrity results and does not treat an unsupported cipher check as corruption', async () => {
    const database = createDatabaseDouble();
    database.getAllAsync.mockImplementation(async (sql) => {
      if (sql === 'PRAGMA quick_check') return [{ quick_check: 'ok' }];
      if (sql === 'PRAGMA cipher_version') return [];
      return [];
    });
    service.database = database;

    await expect(service.verifyNativeIntegrity()).resolves.toEqual({
      quickCheck: 'ok',
      cipherCheck: 'unsupported',
    });
    expect(database.execAsync).not.toHaveBeenCalledWith(expect.stringContaining('DELETE FROM'));
  });

  it('fails closed on a native quick-check error without deleting local tables', async () => {
    const database = createDatabaseDouble();
    database.getAllAsync.mockResolvedValueOnce([{ quick_check: 'database disk image is malformed' }]);
    service.database = database;

    await expect(service.verifyNativeIntegrity()).rejects.toThrow(/integrity check failed/i);
    expect(database.execAsync).not.toHaveBeenCalledWith(expect.stringContaining('DELETE FROM'));
  });

  it('builds bounded retention commands that preserve unresolved records and the active event', async () => {
    const database = createDatabaseDouble();
    service.database = database;
    await DatabaseService.performStorageMaintenance({
      activeEventId: 7,
      now: Date.parse('2026-08-04T12:00:00.000Z'),
    });

    const commands = database.executeBatchAsync.mock.calls[0][0];
    expect(commands.every(([sql]) => compact(sql).includes('LIMIT 500'))).toBe(true);
    expect(commands.map(([sql]) => compact(sql)).join(' ')).toContain("upload_state = 'acknowledged'");
    expect(commands.map(([sql]) => compact(sql)).join(' ')).not.toContain("upload_state IN ('pending', 'retryable')");
    expect(commands.some(([, params]) => params?.includes(7))).toBe(true);
  });

  it('scopes displayed scan history to the selected event', async () => {
    const database = createDatabaseDouble();
    service.database = database;

    await DatabaseService.getScanLogs(7, 10);

    expect(database.getAllAsync).toHaveBeenCalledWith(
      expect.stringContaining('WHERE event_id = ?'),
      [7, 10]
    );
  });

  it('does not record a successful checksum when an atomic snapshot replacement fails', async () => {
    const database = createDatabaseDouble();
    database.executeBatchAsync.mockRejectedValueOnce(new Error('write failed'));
    service.database = database;

    await expect(DatabaseService.upsertSyncedUsers(11, [user(11)])).rejects.toThrow('write failed');

    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('rejects a response containing a user from a different event before writing', async () => {
    const database = createDatabaseDouble();
    service.database = database;

    await expect(DatabaseService.upsertSyncedUsers(11, [user(22)])).rejects.toThrow(
      'Synchronized user 5 belongs to event 22, not 11'
    );

    expect(database.executeBatchAsync).not.toHaveBeenCalled();
  });

  it('delegates batches to the native transactional batch primitive', async () => {
    const executeBatch = jest.fn(async () => ({ rowsAffected: 2 }));
    const database = new SQLiteDatabase({ executeBatch } as never);
    const commands: ([string] | [string, unknown[]])[] = [
      ['DELETE FROM users WHERE event_id = ?', [11]],
      ['INSERT INTO users (event_id, id) VALUES (?, ?)', [11, 5]],
    ];

    await database.executeBatchAsync(commands);

    expect(executeBatch).toHaveBeenCalledWith(commands);
  });

  it('adds queue attempt and terminal columns idempotently without replacing queue rows', async () => {
    const database = createDatabaseDouble();
    database.getAllAsync.mockImplementation(async (sql) => {
      if (sql.includes('PRAGMA table_info(users)')) {
        return [
          { name: 'event_id', notnull: 1, pk: 1 },
          { name: 'id', notnull: 1, pk: 2 },
          { name: 'assignments', notnull: 1, pk: 0 },
        ];
      }
      if (sql.includes('PRAGMA table_info(incidents_queue)') || sql.includes('PRAGMA table_info(overrides_queue)')) {
        return [
          { name: 'client_record_id' },
          { name: 'occurred_at' },
        ];
      }
      return [];
    });
    service.database = database;

    await service.createTables();

    const migrationSql = database.execAsync.mock.calls.map(([sql]) => compact(sql));
    for (const table of ['incidents_queue', 'overrides_queue']) {
      expect(migrationSql).toEqual(expect.arrayContaining([
        `ALTER TABLE ${table} ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE ${table} ADD COLUMN last_attempt_at TEXT`,
        `ALTER TABLE ${table} ADD COLUMN last_error TEXT`,
        `ALTER TABLE ${table} ADD COLUMN terminal_failure INTEGER NOT NULL DEFAULT 0`,
      ]));
    }
    expect(migrationSql.some((sql) => sql.includes('DELETE FROM incidents_queue'))).toBe(false);
    expect(migrationSql.some((sql) => sql.includes('DELETE FROM overrides_queue'))).toBe(false);
  });

  it('device-qualifies only unsynced queue rows that never received an identity', async () => {
    const database = createDatabaseDouble();
    database.getAllAsync.mockImplementation(async (sql) => {
      if (sql.includes('PRAGMA table_info(users)')) {
        return [
          { name: 'event_id', notnull: 1, pk: 1 },
          { name: 'id', notnull: 1, pk: 2 },
          { name: 'assignments', notnull: 1, pk: 0 },
        ];
      }
      return [
        { name: 'client_record_id' },
        { name: 'occurred_at' },
        { name: 'attempt_count' },
        { name: 'last_attempt_at' },
        { name: 'last_error' },
        { name: 'terminal_failure' },
      ];
    });
    service.database = database;

    await service.createTables();

    const incidentMigration = database.runAsync.mock.calls.find(([sql]) =>
      sql.includes('UPDATE incidents_queue')
    );
    const overrideMigration = database.runAsync.mock.calls.find(([sql]) =>
      sql.includes('UPDATE overrides_queue')
    );
    expect(compact(incidentMigration?.[0] ?? '')).toContain(
      'WHERE synced = 0 AND client_record_id IS NULL'
    );
    expect(compact(overrideMigration?.[0] ?? '')).toContain(
      'WHERE synced = 0 AND client_record_id IS NULL'
    );
    expect(incidentMigration?.[1]).toEqual(['legacy-incident-scan-record-id-']);
    expect(overrideMigration?.[1]).toEqual(['legacy-override-scan-record-id-']);
  });

  it('stops before changing weak identities until lost acknowledgements have an approved reconciliation', async () => {
    const database = createDatabaseDouble();
    database.getAllAsync.mockImplementation(async (sql) => {
      if (sql.includes('PRAGMA table_info(users)')) {
        return [
          { name: 'event_id', notnull: 1, pk: 1 },
          { name: 'id', notnull: 1, pk: 2 },
          { name: 'assignments', notnull: 1, pk: 0 },
        ];
      }
      return [
        { name: 'client_record_id' },
        { name: 'occurred_at' },
        { name: 'attempt_count' },
        { name: 'last_attempt_at' },
        { name: 'last_error' },
        { name: 'terminal_failure' },
      ];
    });
    database.getFirstAsync.mockImplementation(async (sql) => (
      sql.includes("client_record_id = 'legacy-incident-' || id")
        ? { incident_count: 1, override_count: 0 }
        : null
    ));
    service.database = database;

    await expect(service.createTables()).rejects.toThrow(
      'Legacy queue reconciliation approval is required'
    );

    expect(database.runAsync).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE incidents_queue'),
      expect.anything()
    );
  });

  it('keeps new incident and override records on random UUID identities', async () => {
    const database = createDatabaseDouble();
    service.database = database;
    const randomUUID = jest.requireMock('expo-crypto').randomUUID as jest.Mock;
    randomUUID
      .mockReturnValueOnce('new-incident-uuid')
      .mockReturnValueOnce('new-override-uuid');

    await DatabaseService.queueIncident(4, 'security', 'New incident');
    await DatabaseService.queueOverride(4, 'Arena', true, 'New override');

    expect(database.runAsync.mock.calls[0][1]?.[0]).toBe('new-incident-uuid');
    expect(database.runAsync.mock.calls[1][1]?.[0]).toBe('new-override-uuid');
    expect(compact(database.runAsync.mock.calls[0][0])).toContain('ON CONFLICT(client_record_id) DO NOTHING');
    expect(compact(database.runAsync.mock.calls[1][0])).toContain('ON CONFLICT(client_record_id) DO NOTHING');
  });

  it('uses caller-stable record IDs for safe operational retries', async () => {
    const database = createDatabaseDouble();
    service.database = database;

    await DatabaseService.queueIncident(4, 'security', 'New incident', undefined, undefined, 'incident-stable');
    await DatabaseService.queueOverride(4, 'Arena', true, 'New override', undefined, undefined, 'override-stable');

    expect(database.runAsync.mock.calls[0][1]?.[0]).toBe('incident-stable');
    expect(database.runAsync.mock.calls[1][1]?.[0]).toBe('override-stable');
  });

  it('reads bounded non-terminal queue rows and stores bounded failure metadata', async () => {
    const database = createDatabaseDouble();
    database.getAllAsync
      .mockResolvedValueOnce([{ id: 1, terminal_failure: 0 }])
      .mockResolvedValueOnce([{ id: 2, terminal_failure: 0, access_granted: 1 }]);
    service.database = database;

    await DatabaseService.getUnsyncedIncidents(10);
    await DatabaseService.getUnsyncedOverrides(10);
    await DatabaseService.recordIncidentFailure(1, `network\n${'x'.repeat(700)}`, false);
    await DatabaseService.recordOverrideFailure(2, 'missing area', true);

    expect(database.getAllAsync).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('terminal_failure = 0'),
      [10]
    );
    expect(database.getAllAsync).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('LIMIT ?'),
      [10]
    );
    const incidentFailure = database.runAsync.mock.calls[0];
    expect(compact(incidentFailure[0])).toContain('attempt_count = attempt_count + 1');
    expect((incidentFailure[1]?.[1] as string).length).toBe(500);
    expect(incidentFailure[1]?.slice(2)).toEqual([0, 1]);
    expect(database.runAsync.mock.calls[1][1]?.slice(2)).toEqual([1, 2]);
  });

  it('stages trust by event and promotes it through one atomic replacement batch', async () => {
    const database = createDatabaseDouble();
    database.getFirstAsync.mockResolvedValueOnce({ generation: 8 });
    service.database = database;
    const page = {
      contract_version: 'qr-trust-v1' as const,
      event_id: 11,
      snapshot_generation: 8,
      generated_at: '2026-07-29T00:00:00.000Z',
      hard_expires_at: '2026-07-30T00:00:00.000Z',
      authority_keys: [{
        kid: 'qr-2026-01',
        public_key: 'BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU',
        status: 'active' as const,
        verify_until: null,
      }],
      revocations: [{
        generation: 8,
        credential_id: '00112233-4455-6677-8899-aabbccddeeff',
        user_id: 5,
        device_id: 'pass-device-1',
        registration_generation: 3,
        credential_expires_at: '2026-07-30T00:00:00.000Z',
        revoked_at: '2026-07-29T00:00:00.000Z',
        reason: 'credential-replaced',
      }],
      has_more: false,
      next_cursor: 'cursor-8',
      checksum: 'a'.repeat(64),
    };

    await DatabaseService.stageQrTrustPage(page, true);
    await DatabaseService.promoteQrTrustSnapshot(11, 8);

    const stageCommands = database.executeBatchAsync.mock.calls[0][0];
    expect(stageCommands.slice(0, 3)).toEqual([
      ['DELETE FROM qr_trust_stage_metadata WHERE event_id = ?', [11]],
      ['DELETE FROM qr_trust_stage_keys WHERE event_id = ?', [11]],
      ['DELETE FROM qr_trust_stage_revocations WHERE event_id = ?', [11]],
    ]);
    expect(stageCommands.every(([, params]) => !params || params.includes(11))).toBe(true);

    expect(database.getFirstAsync).toHaveBeenCalledWith(
      expect.stringContaining('qr_trust_stage_metadata'),
      [11, 8]
    );
    const promotionCommands = database.executeBatchAsync.mock.calls[1][0];
    expect(promotionCommands[0]).toEqual(['DELETE FROM qr_authority_keys WHERE event_id = ?', [11]]);
    expect(promotionCommands[1]).toEqual(['DELETE FROM qr_revocations WHERE event_id = ?', [11]]);
    expect(promotionCommands.map(([sql]) => compact(sql))).toEqual(expect.arrayContaining([
      expect.stringContaining('INSERT INTO qr_trust_metadata'),
      'DELETE FROM qr_trust_stage_metadata WHERE event_id = ?',
      'DELETE FROM qr_trust_stage_keys WHERE event_id = ?',
      'DELETE FROM qr_trust_stage_revocations WHERE event_id = ?',
    ]));
  });

  it('promotes users, areas, trust, and metadata through one authorization transaction', async () => {
    const database = createDatabaseDouble();
    database.getFirstAsync.mockResolvedValueOnce({ generation: 8 });
    service.database = database;

    await DatabaseService.promoteAuthorizationSnapshot({
      eventId: 11,
      event: {
        name: 'Operations',
        is_active: true,
        starts_at: '2026-07-29T00:00:00.000Z',
        ends_at: '2026-07-30T00:00:00.000Z',
      },
      trustGeneration: 8,
      users: [user(11)],
      areas: [{ id: 3, name: 'Arena', requires_scan: true }],
      legacyAuthorityPublicKey: 'legacy-public-key',
    });

    expect(database.executeBatchAsync).toHaveBeenCalledTimes(1);
    const commands = database.executeBatchAsync.mock.calls[0][0];
    expect(commands.slice(0, 4)).toEqual([
      ['DELETE FROM users WHERE event_id = ?', [11]],
      ['DELETE FROM synced_areas WHERE event_id = ?', [11]],
      ['DELETE FROM qr_authority_keys WHERE event_id = ?', [11]],
      ['DELETE FROM qr_revocations WHERE event_id = ?', [11]],
    ]);
    expect(commands.map(([sql]) => compact(sql))).toEqual(expect.arrayContaining([
      expect.stringContaining('INSERT INTO users'),
      expect.stringContaining('INSERT INTO synced_areas'),
      expect.stringContaining('INSERT INTO event_authority'),
      expect.stringContaining('INSERT INTO qr_authority_keys'),
      expect.stringContaining('INSERT INTO qr_revocations'),
      expect.stringContaining('INSERT INTO qr_trust_metadata'),
      expect.stringContaining('INSERT INTO sync_metadata'),
      'DELETE FROM qr_trust_stage_metadata WHERE event_id = ?',
      'DELETE FROM qr_trust_stage_keys WHERE event_id = ?',
      'DELETE FROM qr_trust_stage_revocations WHERE event_id = ?',
    ]));
    expect(commands.every(([, params]) => !params || !params.includes(22))).toBe(true);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('retains the old authorization snapshot when combined promotion fails', async () => {
    const database = createDatabaseDouble();
    database.getFirstAsync.mockResolvedValueOnce({ generation: 8 });
    database.executeBatchAsync.mockRejectedValueOnce(new Error('injected promotion failure'));
    service.database = database;

    await expect(DatabaseService.promoteAuthorizationSnapshot({
      eventId: 11,
      event: {
        name: 'Operations',
        is_active: true,
        starts_at: null,
        ends_at: null,
      },
      trustGeneration: 8,
      users: [user(11)],
      areas: [{ id: 3, name: 'Arena', requires_scan: true }],
      legacyAuthorityPublicKey: 'legacy-public-key',
    })).rejects.toThrow('injected promotion failure');

    expect(database.executeBatchAsync).toHaveBeenCalledTimes(1);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('records nullable-subject decision evidence without raw QR content and acknowledges by attempt id', async () => {
    const database = createDatabaseDouble();
    service.database = database;

    await DatabaseService.logScan({
      event_id: 11,
      user_id: null,
      user_name: null,
      area: 'Arena',
      area_id: 3,
      access_granted: false,
      failure_reason: 'Invalid QR format',
      scanned_at: '2026-07-29T00:00:00.000Z',
      scanner_user: 'Scanner',
      device_scan_id: 'camera-attempt-1',
      credential_id: null,
      nonce_hash: null,
      decision_code: 'malformed_schema',
      decision_source: 'offline-current',
      trust_generation: 8,
      user_snapshot_at: '2026-07-29T00:00:00.000Z',
      scanner_installation_id: 'scan-installation-1',
      manual_reason: null,
      identity_evidence_confirmed: false,
    });
    await DatabaseService.markScanLogSyncedByDeviceId('camera-attempt-1');

    expect(compact(database.runAsync.mock.calls[0][0])).toContain(
      'credential_id, nonce_hash, decision_code, decision_source'
    );
    expect(database.runAsync.mock.calls[0][1]).toEqual([
      11,
      null,
      null,
      'Arena',
      3,
      0,
      'Invalid QR format',
      '2026-07-29T00:00:00.000Z',
      'Scanner',
      'camera-attempt-1',
      null,
      null,
      'malformed_schema',
      'offline-current',
      null,
      0,
      8,
      '2026-07-29T00:00:00.000Z',
      'scan-installation-1',
    ]);
    expect(JSON.stringify(database.runAsync.mock.calls[0])).not.toContain('qr_code');
    expect(database.runAsync).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("upload_state = 'acknowledged'"),
      [expect.any(String), 'camera-attempt-1']
    );
  });

  it('denies signed or local assignments whose active-resource projection is incomplete', async () => {
    const now = Date.now();
    const assignment = {
      area_id: 3,
      area_name: 'Main Arena',
      access_level_id: 2,
      access_level_name: 'VIP',
      access_priority: 5,
      valid_from: new Date(now - 60_000).toISOString(),
      valid_until: new Date(now + 60_000).toISOString(),
    };
    for (const incompleteProjection of ['signed', 'local'] as const) {
      const database = createDatabaseDouble();
      database.getFirstAsync
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ qr_authority_public_key: 'trusted-key' })
        .mockResolvedValueOnce({
          ...user(5),
          allowed_areas: '["Main Arena"]',
          assignments: JSON.stringify([
            incompleteProjection === 'local'
              ? { ...assignment, access_level_id: null }
              : assignment,
          ]),
          is_active: 1,
        });
      service.database = database;
      (QrCredentialService.verify as jest.Mock).mockResolvedValueOnce({
        valid: true,
        presentation: {
          user_id: 5,
          email: 'same@example.com',
          name: 'Event 5',
          event_id: 5,
          credential_id: 'credential-1',
          nonce: 'nonce-1',
          assignments: [
            incompleteProjection === 'signed'
              ? { ...assignment, access_level_id: null }
              : assignment,
          ],
        },
      });

      await expect(DatabaseService.verifyQRCode('{}', 'Main Arena', 5)).resolves.toMatchObject({
        success: false,
        reason: 'No current access assignment for Main Arena',
      });
    }
  });
});
