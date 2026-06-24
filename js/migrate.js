// migrate.js — one-time migration of saved championships from the legacy
// IndexedDB store into Firestore.
//
// The old persistence layer (see git history of db.js) stored championships in
// an IndexedDB database in the user's browser. Since that data is per-browser
// and cannot be reached server-side, the copy runs client-side on startup. It
// is guarded by a localStorage flag so it executes at most once per browser,
// and it leaves the IndexedDB records in place as a local backup.

import { importChampionship } from "./db.js";

const LEGACY_DB_NAME = "cs2_championship_db";
const LEGACY_STORE = "tournament";
const MIGRATED_FLAG = "cs2_idb_migrated_to_firestore_v1";

// Read every record from the legacy IndexedDB store. Resolves [] if IndexedDB
// is unavailable or the database/store doesn't exist. Opens without a version
// so it never triggers the old upgrade logic (which cleared legacy data).
function readLegacyRecords() {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve([]);

    let request;
    try {
      request = indexedDB.open(LEGACY_DB_NAME);
    } catch {
      return resolve([]);
    }

    // Fires only when the DB had to be created — i.e. it never existed, so
    // there is nothing to migrate.
    let freshlyCreated = false;
    request.onupgradeneeded = () => { freshlyCreated = true; };
    request.onerror = () => resolve([]);
    request.onsuccess = (event) => {
      const database = event.target.result;
      if (freshlyCreated || !database.objectStoreNames.contains(LEGACY_STORE)) {
        database.close();
        return resolve([]);
      }
      try {
        const tx = database.transaction(LEGACY_STORE, "readonly");
        const getAll = tx.objectStore(LEGACY_STORE).getAll();
        getAll.onsuccess = () => { database.close(); resolve(getAll.result || []); };
        getAll.onerror = () => { database.close(); resolve([]); };
      } catch {
        database.close();
        resolve([]);
      }
    };
  });
}

function alreadyMigrated() {
  try { return !!localStorage.getItem(MIGRATED_FLAG); } catch { return false; }
}

function markMigrated() {
  try { localStorage.setItem(MIGRATED_FLAG, "1"); } catch { /* ignore */ }
}

// Copy every legacy championship into Firestore. Safe to call on every load:
// it no-ops once the flag is set. Returns the number of records copied.
export async function migrateIndexedDBToFirestore() {
  if (alreadyMigrated()) return 0;

  const records = await readLegacyRecords();
  if (!records.length) {
    // Nothing to move — record that we checked so we don't probe IndexedDB
    // on every future load.
    markMigrated();
    return 0;
  }

  let migrated = 0;
  for (const r of records) {
    if (!r || !r.id) continue;
    try {
      await importChampionship({
        id: r.id,
        name: r.name,
        state: r.state,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      });
      migrated++;
    } catch (e) {
      console.error("migration: failed to copy championship", r.id, e);
    }
  }

  // Only flag complete if every record made it across; otherwise leave the flag
  // unset so the next load retries the ones that failed.
  if (migrated === records.length) markMigrated();

  console.info(
    `migration: copied ${migrated}/${records.length} championship(s) from IndexedDB to Firestore`
  );
  return migrated;
}
