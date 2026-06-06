// db.js — IndexedDB persistence layer.
//
// Multiple championships are stored, each as its own record:
//   { id, name, state, createdAt, updatedAt }
// `state` is the full Tournament snapshot; `id`/`name` identify the saved
// championship so the user can keep several and pick one to continue.

const DB_NAME = "cs2_championship_db";
// v3 introduced the group stage; the tournament snapshot shape changed
// incompatibly, so legacy records are cleared on upgrade.
const DB_VERSION = 3;
const STORE = "tournament";

let db = null;

export function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      const oldVersion = event.oldVersion || 0;
      let store;
      if (!database.objectStoreNames.contains(STORE)) {
        store = database.createObjectStore(STORE, { keyPath: "id" });
      } else {
        store = event.target.transaction.objectStore(STORE);
      }
      if (!store.indexNames.contains("updatedAt")) {
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      // The group-stage format (v3) is not backward compatible with snapshots
      // saved by earlier versions — drop them so the app never loads a state
      // that the renderer/engine cannot handle.
      if (oldVersion > 0 && oldVersion < 3) {
        store.clear();
      }
    };

    request.onsuccess = (event) => {
      db = event.target.result;
      resolve(db);
    };

    request.onerror = () => reject(request.error);
  });
}

function genId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "c-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

// Create a brand-new championship record. Resolves with its metadata.
export function createChampionship(name, state) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const record = { id: genId(), name, state, createdAt: now, updatedAt: now };
    const tx = db.transaction(STORE, "readwrite");
    const request = tx.objectStore(STORE).add(record);
    request.onsuccess = () => resolve(record);
    request.onerror = () => reject(request.error);
  });
}

// Persist an updated snapshot for an existing championship. Falls back to
// creating the record if it somehow no longer exists.
export function saveChampionship(id, state, name) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result || { id, createdAt: Date.now() };
      const record = {
        ...existing,
        id,
        state,
        name: name ?? existing.name ?? "Untitled Championship",
        updatedAt: Date.now(),
      };
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve(record);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// List every saved championship (metadata + state), newest update first.
export function listChampionships() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).getAll();
    request.onsuccess = () => {
      const rows = (request.result || []).map((r) => ({
        id: r.id,
        name: r.name || "Untitled Championship",
        state: r.state,
        createdAt: r.createdAt || 0,
        updatedAt: r.updatedAt || 0,
      }));
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
      resolve(rows);
    };
    request.onerror = () => reject(request.error);
  });
}

// Load a single championship by id. Resolves null when not found.
export function loadChampionship(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(id);
    request.onsuccess = () => {
      const r = request.result;
      resolve(r ? { id: r.id, name: r.name || "Untitled Championship", state: r.state } : null);
    };
    request.onerror = () => reject(request.error);
  });
}

export function deleteChampionship(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const request = tx.objectStore(STORE).delete(id);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}
