import { open, type DB } from '@op-engineering/op-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

/**
 * Genuine at-rest encryption for the local SQLite database (Phase 6b),
 * replacing the plaintext expo-sqlite file with an op-sqlite database opened
 * under SQLCipher, keyed by a random 256-bit key generated on first run and
 * stored in the platform secure keystore (iOS Keychain / Android Keystore
 * via expo-secure-store) - never hardcoded, never derived from a passphrase.
 *
 * IMPORTANT: op-sqlite is a native module. This only works in a custom dev
 * client / prebuilt app (`npx expo prebuild`, then `expo run:android` /
 * `expo run:ios`, or an EAS "development" build) - it cannot run inside
 * Expo Go. See README "Local database encryption" for build steps.
 *
 * This module exposes the same method names/shapes as expo-sqlite's async
 * API (openDatabaseAsync/execAsync/runAsync/getFirstAsync/getAllAsync) so
 * DatabaseService.ts only needed to change its import, not every call site.
 */

async function getOrCreateDeviceKey(dbName: string): Promise<string> {
  const keyName = `sqlcipher_key_${dbName}`;
  let key = await SecureStore.getItemAsync(keyName);
  if (!key) {
    const randomBytes = await Crypto.getRandomBytesAsync(32);
    key = Array.from(randomBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    await SecureStore.setItemAsync(keyName, key);
  }
  return key;
}

export class SQLiteDatabase {
  constructor(private readonly db: DB) {}

  async execAsync(sql: string): Promise<void> {
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await this.db.execute(statement);
    }
  }

  async runAsync(sql: string, params: unknown[] = []): Promise<{ lastInsertRowId: number; changes: number }> {
    const result = await this.db.execute(sql, params);
    return { lastInsertRowId: Number(result.insertId ?? 0), changes: result.rowsAffected ?? 0 };
  }

  async getFirstAsync<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    const result = await this.db.execute(sql, params);
    const rows = (result.rows ?? []) as T[];
    return rows.length > 0 ? rows[0] : null;
  }

  async getAllAsync<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.db.execute(sql, params);
    return (result.rows ?? []) as T[];
  }
}

export async function openDatabaseAsync(dbName: string): Promise<SQLiteDatabase> {
  const encryptionKey = await getOrCreateDeviceKey(dbName);
  const db = open({ name: dbName, encryptionKey });
  return new SQLiteDatabase(db);
}
