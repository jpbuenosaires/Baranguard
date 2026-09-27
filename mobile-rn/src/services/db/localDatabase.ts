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

/**
 * Query-shaped adapter over expo-sqlite's async API. The repository files
 * under this folder are ported near-verbatim from ../mobile's
 * @capacitor-community/sqlite versions, which called `db.query()`/`db.run()`
 * inside explicit `beginTransaction()`/`commitTransaction()`/
 * `rollbackTransaction()` — this wrapper gives them the same shape over
 * expo-sqlite (`getAllAsync`/`runAsync`/raw `BEGIN`/`COMMIT`/`ROLLBACK`) so
 * the SQL and control flow in each repository didn't need rewriting, only
 * the import.
 */
export interface CompatDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ values: T[] }>;
  run(sql: string, params?: unknown[], _transaction?: boolean): Promise<void>;
  beginTransaction(): Promise<void>;
  commitTransaction(): Promise<void>;
  rollbackTransaction(): Promise<void>;
}

function toCompatDb(db: SQLiteDatabase): CompatDb {
  return {
    async query(sql, params = []) {
      return { values: await db.getAllAsync(sql, params as (string | number | null)[]) };
    },
    async run(sql, params = []) {
      await db.runAsync(sql, params as (string | number | null)[]);
    },
    beginTransaction: () => db.execAsync('BEGIN'),
    commitTransaction: () => db.execAsync('COMMIT'),
    rollbackTransaction: () => db.execAsync('ROLLBACK'),
  };
}

let database: SQLiteDatabase | null = null;
/**
 * The one open in flight. Carried over from the old app's 2026-09-19 device
 * bug: Home's cache reads and the sync scheduler all opened concurrently at
 * cold start, each ran its own open+migrate, and Home read empty results.
 */
let opening: Promise<SQLiteDatabase> | null = null;

export async function openLocalDatabase(): Promise<CompatDb> {
  return toCompatDb(await openRawDatabase());
}

function openRawDatabase(): Promise<SQLiteDatabase> {
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
