// db.js — Firestore persistence layer.
//
// Championships live in the "championships" collection of the named Firestore
// database (see firebase.js). Each document is:
//   { name, stateJson, createdAt, updatedAt, crewId, memberUids[], createdBy }
// The full Tournament snapshot is serialized into `stateJson` because the
// snapshot contains directly-nested arrays (e.g. `rounds` is an array of
// arrays), which Firestore does not allow as native fields.
//
// Championships are scoped to a "crew" (a collaborative Team of users — see
// crews.js): `crewId` is the owning crew and `memberUids` is a denormalized
// copy of that crew's members, used both to list a user's championships
// (array-contains query) and to authorize access in firestore.rules.

import { db } from "./firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  query,
  where,
  limit,
} from "firebase/firestore";

const COLLECTION = "championships";

// Collections written by the external CS2 extractor plugin (read-only here).
// `cs_extractor_match` holds one document per played map keyed by `matchUuid`
// (the per-map UUID we generate); `cs_extractor_player_match` holds one
// denormalized per-player record per match, doc id `${userId}_${matchUuid}`.
const CS_MATCH_COLLECTION = "cs_extractor_match";
const CS_PLAYER_MATCH_COLLECTION = "cs_extractor_player_match";

// Kept for API compatibility with the previous IndexedDB layer. The Firestore
// SDK needs no explicit open step, so there is nothing to initialize here.
export function initDB() {
  return Promise.resolve();
}

function genId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "c-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function col() {
  return collection(db, COLLECTION);
}

// Map a Firestore document into the metadata + state shape the app expects.
function fromDoc(snap) {
  const d = snap.data() || {};
  let state = null;
  try {
    state = d.stateJson ? JSON.parse(d.stateJson) : d.state ?? null;
  } catch (e) {
    console.error("failed to parse championship state", e);
  }
  return {
    id: snap.id,
    name: d.name || "Untitled Championship",
    state,
    crewId: d.crewId || null,
    memberUids: d.memberUids || [],
    createdBy: d.createdBy || null,
    createdAt: d.createdAt || 0,
    updatedAt: d.updatedAt || 0,
  };
}

// Create a championship owned by `crewId`. `memberUids` is a snapshot of the
// crew's members and `createdBy` is the creator's uid; both are required by the
// security rules. Resolves with the championship metadata.
export async function createChampionship(name, state, crewId, memberUids, createdBy) {
  const now = Date.now();
  const id = genId();
  const record = {
    name: name || "Untitled Championship",
    stateJson: JSON.stringify(state),
    crewId: crewId || null,
    memberUids: memberUids || [],
    createdBy: createdBy || null,
    createdAt: now,
    updatedAt: now,
  };
  await setDoc(doc(db, COLLECTION, id), record);
  return { id, name: record.name, state, crewId: record.crewId, memberUids: record.memberUids, createdBy, createdAt: now, updatedAt: now };
}

// Persist an updated snapshot for an existing championship. Preserves the
// crew-scoping fields (crewId/memberUids/createdBy) — the update rule rejects a
// write that drops or alters them, and setDoc overwrites the whole document.
export async function saveChampionship(id, state, name) {
  const ref = doc(db, COLLECTION, id);
  const existing = await getDoc(ref);
  const prev = existing.exists() ? existing.data() : {};
  const createdAt = prev.createdAt || Date.now();
  const resolvedName = name ?? prev.name ?? "Untitled Championship";
  const now = Date.now();
  const record = {
    name: resolvedName,
    stateJson: JSON.stringify(state),
    crewId: prev.crewId || null,
    memberUids: prev.memberUids || [],
    createdBy: prev.createdBy || null,
    createdAt,
    updatedAt: now,
  };
  await setDoc(ref, record);
  return { id, name: resolvedName, state, crewId: record.crewId, memberUids: record.memberUids, createdAt, updatedAt: now };
}

// List championships the user (uid) can access — i.e. those whose denormalized
// memberUids contains their uid — newest update first. Sorted client-side to
// avoid requiring an array-contains + orderBy composite index.
export async function listChampionships(uid) {
  if (!uid) return [];
  const snap = await getDocs(query(col(), where("memberUids", "array-contains", uid)));
  return snap.docs.map(fromDoc).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// Load a single championship by id. Resolves null when not found.
export async function loadChampionship(id) {
  const snap = await getDoc(doc(db, COLLECTION, id));
  if (!snap.exists()) return null;
  const { name, state, crewId, memberUids } = fromDoc(snap);
  return { id, name, state, crewId, memberUids };
}

export async function deleteChampionship(id) {
  await deleteDoc(doc(db, COLLECTION, id));
  return true;
}

// ---- CS extractor reads ---------------------------------------------------

// Fetch the extracted CS match for a single map UUID, or null if the plugin
// hasn't uploaded it yet.
export async function getCsMatch(matchUuid) {
  if (!matchUuid) return null;
  const snap = await getDocs(
    query(collection(db, CS_MATCH_COLLECTION), where("matchUuid", "==", matchUuid), limit(1))
  );
  return snap.empty ? null : snap.docs[0].data();
}

// Fetch every uploaded CS match for the given map UUIDs. Returns a map of
// matchUuid -> match data (UUIDs with no upload yet are simply absent).
// Firestore "in" filters take at most 10 values, so we query in chunks.
export async function getCsMatches(matchUuids) {
  const ids = [...new Set((matchUuids || []).filter(Boolean))];
  const out = {};
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const snap = await getDocs(
      query(collection(db, CS_MATCH_COLLECTION), where("matchUuid", "in", chunk))
    );
    snap.forEach((d) => {
      const data = d.data();
      if (data && data.matchUuid) out[data.matchUuid] = data;
    });
  }
  return out;
}

// Every per-player match record for a single user across all championships.
// Used by the global all-time dashboard. Sorted newest-first client-side.
export async function getCsPlayerMatchesByUser(uid) {
  if (!uid) return [];
  const snap = await getDocs(
    query(collection(db, CS_PLAYER_MATCH_COLLECTION), where("userId", "==", uid))
  );
  return snap.docs
    .map((d) => d.data())
    .sort((a, b) => (toMillis(b.endedAtUtc) || 0) - (toMillis(a.endedAtUtc) || 0));
}

// ---- User profile (CS nickname) ------------------------------------------

const PROFILE_COLLECTION = "profiles";

// The signed-in user's profile doc ({ uid, nickname, updatedAt }), or null.
export async function getProfile(uid) {
  if (!uid) return null;
  const snap = await getDoc(doc(db, PROFILE_COLLECTION, uid));
  return snap.exists() ? snap.data() : null;
}

// Create/update the user's profile. Doc id is the uid (enforced by the rules).
export async function saveProfile(uid, nickname) {
  if (!uid) throw new Error("saveProfile: missing uid");
  const record = { uid, nickname: (nickname || "").trim(), updatedAt: Date.now() };
  await setDoc(doc(db, PROFILE_COLLECTION, uid), record, { merge: true });
  return record;
}

// Firestore Timestamp | millis | Date -> millis (best-effort, 0 if unknown).
function toMillis(v) {
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v.seconds != null) return v.seconds * 1000;
  const t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}

// Write a championship using a caller-supplied id and timestamps, overwriting
// any existing document with that id. Used by the one-time IndexedDB ->
// Firestore migration so original records keep their id and created/updated
// times. Carries crew-scoping fields so imported records are accessible.
export async function importChampionship(record) {
  const { id, name, state, createdAt, updatedAt, crewId, memberUids, createdBy } = record;
  const now = Date.now();
  await setDoc(doc(db, COLLECTION, id), {
    name: name || "Untitled Championship",
    stateJson: JSON.stringify(state),
    crewId: crewId || null,
    memberUids: memberUids || [],
    createdBy: createdBy || null,
    createdAt: createdAt || now,
    updatedAt: updatedAt || now,
  });
  return id;
}
