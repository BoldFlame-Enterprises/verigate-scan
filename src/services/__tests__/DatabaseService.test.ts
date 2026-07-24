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
jest.mock('../QrCredentialService', () => ({ QrCredentialService: {} }));

import * as SecureStore from 'expo-secure-store';
import { DatabaseService, User } from '../DatabaseService';
import { SQLiteDatabase } from '../EncryptedSQLite';

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

    expect(database.executeBatchAsync).toHaveBeenCalledTimes(1);
    const commands = database.executeBatchAsync.mock.calls[0][0];
    expect(compact(commands[1][0])).toContain('PRIMARY KEY (event_id, id)');
    expect(compact(commands[1][0])).toContain('UNIQUE (event_id, email)');
    expect(compact(commands[2][0])).toContain('SELECT id, COALESCE(event_id, 0)');
    expect(commands.map(([sql]) => compact(sql))).toEqual(expect.arrayContaining([
      'DROP TABLE users',
      'ALTER TABLE users_event_scoped RENAME TO users',
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
});
