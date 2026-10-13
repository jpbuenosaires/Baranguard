/**
 * incidentCodeService.ts — fills in the official incident code (`display_id`,
 * INC-YYYY-NNN) on locally cached rows. Neither `/sync/batch` results nor
 * `GET /dispatch` return it, so this reads `GET /incidents/:id` for each
 * synced/dispatched incident whose code is still unknown and stores it on
 * `incident_local` and `dispatch_local`. Best-effort and offline-safe: a
 * failure just leaves the visibly-unofficial `INC-#id` fallback in place.
 */
import { getIncidentDisplayId } from './apiService';
import { openLocalDatabase } from './db/localDatabase';

const MAX_PER_PASS = 20;
let running = false;

export async function resolveMissingIncidentCodes(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const db = await openLocalDatabase();
    const ids = new Set<number>();
    const a = await db.query(
      'SELECT DISTINCT server_incident_id AS id FROM incident_local WHERE server_incident_id IS NOT NULL AND display_id IS NULL LIMIT ?',
      [MAX_PER_PASS]
    );
    for (const r of a.values ?? []) ids.add(Number((r as { id: number }).id));
    const b = await db.query(
      'SELECT DISTINCT server_incident_id AS id FROM dispatch_local WHERE incident_display_id IS NULL LIMIT ?',
      [MAX_PER_PASS]
    );
    for (const r of b.values ?? []) ids.add(Number((r as { id: number }).id));

    let n = 0;
    for (const id of ids) {
      if (n++ >= MAX_PER_PASS) break;
      let code: string | null;
      try {
        code = await getIncidentDisplayId(id);
      } catch {
        return; // offline or unauthorised: try again on the next pass
      }
      if (!code) continue;
      await db.run('UPDATE incident_local SET display_id = ? WHERE server_incident_id = ?', [code, id], false);
      await db.run('UPDATE dispatch_local SET incident_display_id = ? WHERE server_incident_id = ?', [code, id], false);
    }
  } catch {
    // never let a cosmetic lookup break sync or the dispatch cache
  } finally {
    running = false;
  }
}
