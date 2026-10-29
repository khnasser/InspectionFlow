import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import type { KeyValueStore } from '@inspectionflow/sync-client';

/**
 * Encrypted on-device store: SQLite with SQLCipher (expo-sqlite plugin option
 * useSQLCipher); the database key is random per install and held in the
 * Keychain / Android Keystore via SecureStore. Revoking the device on the
 * server plus "Reset" here wipes everything.
 */
export class SqliteStore implements KeyValueStore {
  private constructor(private readonly db: SQLite.SQLiteDatabase) {}

  static async open(): Promise<SqliteStore> {
    let key = await SecureStore.getItemAsync('if.dbkey');
    if (!key) {
      const bytes = Crypto.getRandomBytes(32);
      key = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      await SecureStore.setItemAsync('if.dbkey', key, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    }
    const db = await SQLite.openDatabaseAsync('inspectionflow.db');
    await db.execAsync(`PRAGMA key = "x'${key}'";`);
    await db.execAsync('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL);');
    return new SqliteStore(db);
  }

  async get(k: string) {
    const row = await this.db.getFirstAsync<{ v: string }>('SELECT v FROM kv WHERE k = ?', [k]);
    return row?.v ?? null;
  }
  async set(k: string, v: string) {
    await this.db.runAsync('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', [k, v]);
  }
  async delete(k: string) {
    await this.db.runAsync('DELETE FROM kv WHERE k = ?', [k]);
  }
  async keys(prefix: string) {
    const rows = await this.db.getAllAsync<{ k: string }>('SELECT k FROM kv WHERE k LIKE ? ORDER BY k', [`${prefix}%`]);
    return rows.map((r) => r.k);
  }
  async wipe() {
    await this.db.runAsync('DELETE FROM kv');
  }
}
