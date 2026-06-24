// db.js — Firestore persistence layer.
//
// Multiple championships are stored in the "championships" collection of the
// named Firestore database (see firebase.js). Each document is:
//   { name, stateJson, createdAt, updatedAt }
// The full Tournament snapshot is serialized into `stateJson` because the
// snapshot contains directly-nested arrays (e.g. `rounds` is an array of
// arrays), which Firestore does not allow as native fields. `name` and the
// timestamps are kept as real fields so they can be queried and ordered.

import { db } from "./firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  query,
  orderBy,
} from "firebase/firestore";

const COLLECTION = "championships";

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
    createdAt: d.createdAt || 0,
    updatedAt: d.updatedAt || 0,
  };
}

// Create a brand-new championship record. Resolves with its metadata.
export async function createChampionship(name, state) {
  const now = Date.now();
  const id = genId();
  const record = {
    name: name || "Untitled Championship",
    stateJson: JSON.stringify(state),
    createdAt: now,
    updatedAt: now,
  };
  await setDoc(doc(db, COLLECTION, id), record);
  return { id, name: record.name, state, createdAt: now, updatedAt: now };
}

// Persist an updated snapshot for an existing championship. Falls back to
// creating the record if it somehow no longer exists.
export async function saveChampionship(id, state, name) {
  const ref = doc(db, COLLECTION, id);
  const existing = await getDoc(ref);
  const createdAt = existing.exists() ? existing.data().createdAt || Date.now() : Date.now();
  const resolvedName =
    name ?? (existing.exists() ? existing.data().name : null) ?? "Untitled Championship";
  const now = Date.now();
  const record = {
    name: resolvedName,
    stateJson: JSON.stringify(state),
    createdAt,
    updatedAt: now,
  };
  await setDoc(ref, record);
  return { id, name: resolvedName, state, createdAt, updatedAt: now };
}

// List every saved championship (metadata + state), newest update first.
export async function listChampionships() {
  const snap = await getDocs(query(col(), orderBy("updatedAt", "desc")));
  return snap.docs.map(fromDoc);
}

// Load a single championship by id. Resolves null when not found.
export async function loadChampionship(id) {
  const snap = await getDoc(doc(db, COLLECTION, id));
  if (!snap.exists()) return null;
  const { name, state } = fromDoc(snap);
  return { id, name, state };
}

export async function deleteChampionship(id) {
  await deleteDoc(doc(db, COLLECTION, id));
  return true;
}

// Write a championship using a caller-supplied id and timestamps, overwriting
// any existing document with that id. Used by the one-time IndexedDB ->
// Firestore migration so original records keep their id and created/updated
// times instead of getting fresh ones.
export async function importChampionship(record) {
  const { id, name, state, createdAt, updatedAt } = record;
  const now = Date.now();
  await setDoc(doc(db, COLLECTION, id), {
    name: name || "Untitled Championship",
    stateJson: JSON.stringify(state),
    createdAt: createdAt || now,
    updatedAt: updatedAt || now,
  });
  return id;
}
