/**
 * Opens and migrates the encrypted local store (expo-sqlite built with
 * SQLCipher via app.config.ts's `useSQLCipher`). The schema itself lives in
 * `localSchema.ts`, which is plain SQL so `scripts/verify-local-schema.mjs`
 * can check it in Node without a device.
 *
 * Upgraded in place via `PRAGMA user_version`, never dropped and recreated:
 * a rebuild would destroy unsynced field captures (Rule 7).
 */
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { LOCAL_MIGRATIONS } from './localSchema';
import { getOrCreatePassphrase } from './passphrase';

const DATABASE_NAME = 'baranguard.db';
const HEX_PASSPHRASE = /^[0-9a-f]{64}$/;

export type LocalDatabase = SQLiteDatabase;

let database: SQLiteDatabase | null = null;
/**
 * The one open in flight. Carried over from the old app's 2026-09-19 device
 * bug: Home's cache reads and the sync scheduler all opened concurrently at
 * cold start, each ran its own open+migrate, and Home read empty results.
 */
let opening: Promise<SQLiteDatabase> | null = null;

export function openLocalDatabase(): Promise<SQLiteDatabase> {
  if (database) return Promise.resolve(database);
  if (!opening) {
    opening = openUncontended().finally(() => {
      opening = null;
    });
  }
  return opening;
}

async function openUncontended(): Promise<SQLiteDatabase> {
  if (database) return database;

  const passphrase = await getOrCreatePassphrase();
  // PRAGMA key can't be parameterized. Only ever interpolate a value this
  // app generated itself, and refuse anything that isn't exactly that shape.
  if (!HEX_PASSPHRASE.test(passphrase)) {
    throw new Error('Local database passphrase is malformed; refusing to open.');
  }

  const db = await openDatabaseAsync(DATABASE_NAME);
  try {
    // SQLCipher requires the key before ANY other statement touches the file.
    await db.execAsync(`PRAGMA key = '${passphrase}'`);
    // First real read: fails with "file is not a database" on a wrong key,
    // instead of letting that surface later inside some unrelated query.
    await db.getFirstAsync('SELECT count(*) FROM sqlite_master');
    await migrateLocalDatabase(db);
  } catch (error) {
    await db.closeAsync().catch(() => undefined);
    throw error;
  }

  database = db;
  return db;
}

/** Applies pending migrations, each in its own exclusive transaction. */
export async function migrateLocalDatabase(db: SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const currentVersion = Number(row?.user_version ?? 0);

  for (let version = currentVersion; version < LOCAL_MIGRATIONS.length; version += 1) {
    const statements = LOCAL_MIGRATIONS[version];
    await db.withExclusiveTransactionAsync(async (txn) => {
      for (const statement of statements) {
        await txn.execAsync(statement);
      }
      // `version + 1` comes from the migration array's own length, never input.
      await txn.execAsync(`PRAGMA user_version = ${version + 1}`);
    });
  }
  return Math.max(currentVersion, LOCAL_MIGRATIONS.length);
}

/** Closes the store. Called on logout. */
export async function closeLocalDatabase(): Promise<void> {
  if (opening) await opening.catch(() => undefined);
  if (database) {
    const db = database;
    database = null;
    await db.closeAsync();
  }
}
