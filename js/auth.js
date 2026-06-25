// auth.js — Firebase Authentication (Google sign-in) wrappers.
//
// The whole app is gated behind sign-in: main() subscribes via onAuth() and
// renders either the sign-in screen or the app depending on the current user.

import { auth } from "./firebase.js";
import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";

const provider = new GoogleAuthProvider();

// Subscribe to auth-state changes. Calls `cb(user|null)` immediately with the
// current state and again on every change. Returns an unsubscribe function.
export function onAuth(cb) {
  return onAuthStateChanged(auth, cb);
}

export function currentUser() {
  return auth.currentUser;
}

// The signed-in user's email, lowercased, or null. Used to match crew invites.
export function currentUserEmail() {
  const e = auth.currentUser && auth.currentUser.email;
  return e ? e.toLowerCase() : null;
}

// Open the Google sign-in popup. Resolves with the signed-in user.
export async function signInWithGoogle() {
  const res = await signInWithPopup(auth, provider);
  return res.user;
}

export function signOutUser() {
  return signOut(auth);
}
