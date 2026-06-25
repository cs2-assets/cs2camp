// crews.js — data layer for "Teams" (collaborative user groups).
//
// Labeled "Team" in the UI; named `crew` in code/data to avoid colliding with
// the CS esports roster ("team"/selectedTeamId/TEAMS). A crew groups users who
// all see and edit the crew's championships.
//
//   crews/{id} = { name, ownerUid, memberUids[], invitedEmails[], createdAt, updatedAt }
//
// Access is enforced by firestore.rules; these helpers just shape the writes so
// they satisfy those rules (notably the constrained self-join on acceptInvite).

import { db } from "./firebase.js";
import { auth } from "./firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  arrayUnion,
  arrayRemove,
  writeBatch,
} from "firebase/firestore";

const CREWS = "crews";
const CHAMPS = "championships";

function uid() {
  return auth.currentUser ? auth.currentUser.uid : null;
}
function email() {
  const e = auth.currentUser && auth.currentUser.email;
  return e ? e.toLowerCase() : null;
}
function requireUid() {
  const u = uid();
  if (!u) throw new Error("Not signed in");
  return u;
}

function fromCrew(snap) {
  const d = snap.data() || {};
  return {
    id: snap.id,
    name: d.name || "Untitled Team",
    ownerUid: d.ownerUid || "",
    memberUids: d.memberUids || [],
    invitedEmails: d.invitedEmails || [],
    createdAt: d.createdAt || 0,
    updatedAt: d.updatedAt || 0,
  };
}

const byUpdatedDesc = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);

// Create a crew owned by the current user (sole initial member).
export async function createCrew(name) {
  const u = requireUid();
  const ref = doc(collection(db, CREWS));
  const now = Date.now();
  const data = {
    name: (name || "").trim() || "My Team",
    ownerUid: u,
    memberUids: [u],
    invitedEmails: [],
    createdAt: now,
    updatedAt: now,
  };
  await setDoc(ref, data);
  return { id: ref.id, ...data };
}

// Crews the current user is a member of (sorted newest-updated first).
export async function listMyCrews() {
  const u = uid();
  if (!u) return [];
  const snap = await getDocs(query(collection(db, CREWS), where("memberUids", "array-contains", u)));
  return snap.docs.map(fromCrew).sort(byUpdatedDesc);
}

// Crews that have invited the current user's email but not yet joined.
export async function listMyInvites() {
  const e = email();
  if (!e) return [];
  const snap = await getDocs(query(collection(db, CREWS), where("invitedEmails", "array-contains", e)));
  return snap.docs.map(fromCrew).sort(byUpdatedDesc);
}

export async function getCrew(crewId) {
  const snap = await getDoc(doc(db, CREWS, crewId));
  return snap.exists() ? fromCrew(snap) : null;
}

// Owner-only (per rules): invite a friend by email. No account needed yet.
export async function inviteEmail(crewId, rawEmail) {
  const e = (rawEmail || "").trim().toLowerCase();
  if (!e) return;
  await updateDoc(doc(db, CREWS, crewId), {
    invitedEmails: arrayUnion(e),
    updatedAt: Date.now(),
  });
}

// Owner-only: revoke a pending invite.
export async function revokeInvite(crewId, rawEmail) {
  const e = (rawEmail || "").trim().toLowerCase();
  await updateDoc(doc(db, CREWS, crewId), {
    invitedEmails: arrayRemove(e),
    updatedAt: Date.now(),
  });
}

// Invited user self-joins: add own uid to members, remove own email from
// invitedEmails. Matches the "self-join" branch of the security rules.
export async function acceptInvite(crewId) {
  const u = requireUid();
  const e = email();
  await updateDoc(doc(db, CREWS, crewId), {
    memberUids: arrayUnion(u),
    invitedEmails: arrayRemove(e),
    updatedAt: Date.now(),
  });
}

// Remove a member. The owner may remove anyone; a non-owner member may remove
// only themselves (leave). Both map to arrayRemove(uid) and are permitted by
// the owner / self-leave rule branches.
export async function removeMember(crewId, memberUid) {
  await updateDoc(doc(db, CREWS, crewId), {
    memberUids: arrayRemove(memberUid),
    updatedAt: Date.now(),
  });
}

// Current user leaves a crew they don't own.
export async function leaveCrew(crewId) {
  return removeMember(crewId, requireUid());
}

// Owner-only: delete the crew document. (Championships are left intact; callers
// should handle them separately if desired.)
export async function deleteCrew(crewId) {
  await deleteDoc(doc(db, CREWS, crewId));
}

// Propagate the crew's authoritative memberUids onto every one of its
// championships so members see/edit existing championships (not just ones
// created after they joined). Run by a member who can already read those docs
// (in practice the owner). Best-effort; safe to call repeatedly.
export async function syncCrewMembership(crewId) {
  const crew = await getCrew(crewId);
  if (!crew) return;
  const snap = await getDocs(query(collection(db, CHAMPS), where("crewId", "==", crewId)));
  const stale = snap.docs.filter((d) => {
    const cur = d.data().memberUids || [];
    return cur.length !== crew.memberUids.length
      || crew.memberUids.some((m) => !cur.includes(m));
  });
  if (!stale.length) return;
  const batch = writeBatch(db);
  for (const d of stale) {
    batch.update(d.ref, { memberUids: crew.memberUids, updatedAt: Date.now() });
  }
  await batch.commit();
}
