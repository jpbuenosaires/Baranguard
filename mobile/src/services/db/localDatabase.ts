/**
 * localDatabase.ts — opens and migrates the encrypted local SQLite store
 * (§1: SQLite via @capacitor-community/sqlite, SQLCipher-backed;
 * §5 "Mobile Local").
 *
 * This is the thin PLATFORM EDGE of the local-storage layer. The schema
 * itself lives in `localSchema.ts`, which imports nothing from Capacitor
 * precisely so the exact DDL can be executed against a real SQLite engine
 * and asserted against §5 without a device
 * (`mobile/scripts/verify-local-schema.mjs`). Everything in *this* file
 * requires a real Android device/emulator to exercise — see the DEVLOG
 * entry for this cut, which flags it as written-but-not-device-verified
 * rather than claiming otherwise.
 *
 * Migration policy mirrors the backend's numbered migrations: the store
 * is upgraded in place via `PRAGMA user_version`, never dropped and
 * recreated. Rule 2 makes that non-negotiable — a rebuild would destroy
 * field captures that have not yet been reconciled with the server.
 */

import { Capacitor } from '@capacitor/core';
import {
  CapacitorSQLite,
  SQLiteConnection,
  type SQLiteDBConnection,
} from '@capacitor-community/sqlite';
import { LOCAL_MIGRATIONS, LOCAL_SCHEMA_VERSION } from './localSchema';

const DATABASE_NAME = 'baranguard';

/**
 * Supplies the SQLCipher passphrase for the local store.
 *
 * UNRESOLVED DESIGN DECISION — deliberately left as a seam, not defaulted.
 * §5 requires the local database to be encrypted at rest but never
 * specifies where the key comes from, and §6 defines no key-provisioning
 * endpoint. A hardcoded constant here would make the "encrypted at rest"
 * claim hollow (the key would ship inside the APK for anyone to read),
 * which is exactly the kind of demo-tell §8 forbids — so this module
 * refuses to run without an explicitly configured provider instead of
 * quietly inventing a key. Resolve before M1/M3 actually persist a real
 * `raw_narrative`; candidates are a device-keystore-backed random secret
 * generated at registration, or a server-issued per-device secret
 * delivered during `POST /devices/register`.
 */
export type PassphraseProvider = () => Promise<string>;

let passphraseProvider: PassphraseProvider | null = null;
let connection: SQLiteConnection | null = null;
let database: SQLiteDBConnection | null = null;

/** Register the passphrase source. Must be called before `openLocalDatabase()`. */
export function configureLocalDatabase(provider: PassphraseProvider): void {
  passphraseProvider = provider;
}

/**
 * Opens (creating if needed) the encrypted local database and brings it
 * up to `LOCAL_SCHEMA_VERSION`. Safe to call repeatedly — returns the
 * existing open connection.
 */
export async function openLocalDatabase(): Promise<SQLiteDBConnection> {
  if (database) {
    return database;
  }
  if (!passphraseProvider) {
    throw new Error(
      'configureLocalDatabase() must be called with a PassphraseProvider before opening the local database.'
    );
  }
  if (Capacitor.getPlatform() === 'web') {
    // The plugin's web target needs the `jeep-sqlite` element plus a wasm
    // build, and it is NOT SQLCipher-encrypted. §1 targets Android; rather
    // than silently opening an unencrypted browser store that looks like
    // the real thing, fail loudly until web support is a deliberate,
    // separately-reviewed decision.
    throw new Error(
      'The encrypted local store is Android-only right now; web support is not wired up (see localDatabase.ts).'
    );
  }

  connection = new SQLiteConnection(CapacitorSQLite);

  const secret = await passphraseProvider();
  const isSecretStored = (await connection.isSecretStored()).result === true;
  if (!isSecretStored) {
    await connection.setEncryptionSecret(secret);
  }

  database = await connection.createConnection(
    DATABASE_NAME,
    /* encrypted */ true,
    /* mode */ 'secret',
    LOCAL_SCHEMA_VERSION,
    /* readonly */ false
  );
  await database.open();
  await migrateLocalDatabase(database);
  return database;
}

/**
 * Applies any migrations the open database has not seen yet, tracked via
 * `PRAGMA user_version`. Each migration runs inside its own transaction
 * so a partial upgrade cannot leave a half-created schema behind.
 */
export async function migrateLocalDatabase(db: SQLiteDBConnection): Promise<number> {
  const result = await db.query('PRAGMA user_version');
  const currentVersion = Number(result.values?.[0]?.user_version ?? 0);

  if (currentVersion >= LOCAL_MIGRATIONS.length) {
    return currentVersion;
  }

  for (let version = currentVersion; version < LOCAL_MIGRATIONS.length; version += 1) {
    const statements = LOCAL_MIGRATIONS[version];
    await db.beginTransaction();
    try {
      for (const statement of statements) {
        await db.execute(statement, /* transaction */ false);
      }
      // PRAGMA cannot be parameterized; `version + 1` is a locally-derived
      // integer from the migration array's own length, never user input.
      await db.execute(`PRAGMA user_version = ${version + 1}`, false);
      await db.commitTransaction();
    } catch (error) {
      await db.rollbackTransaction();
      throw error;
    }
  }

  return LOCAL_MIGRATIONS.length;
}

/** Closes the local database. Call on logout/teardown. */
export async function closeLocalDatabase(): Promise<void> {
  if (database) {
    await database.close();
    database = null;
  }
  if (connection) {
    await connection.closeConnection(DATABASE_NAME, false);
    connection = null;
  }
}
