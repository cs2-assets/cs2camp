// firebase.js — Firebase app + Firestore initialization.
//
// The web SDK config is not secret (it identifies the project to the client);
// access is governed by Firestore security rules, not by hiding these values.
// We connect to the named Firestore database "chemist-site" rather than the
// project's "(default)" database.

import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyAMCf9GMHC3O2OIx3O29QKLkAsWPQ9F9_M",
  authDomain: "onbim-stage.firebaseapp.com",
  projectId: "onbim-stage",
  storageBucket: "onbim-stage.firebasestorage.app",
  messagingSenderId: "794651810954",
  appId: "1:794651810954:web:48028283c8ba0aac732173",
  measurementId: "G-4R4QPNBT3L",
};

// Named Firestore database the app reads/writes.
export const FIRESTORE_DATABASE_ID = "chemist-site";

// Habit Farm lives in the same Firebase project but a different named database.
// We write champion rewards into its "rewards" collection (see rewards.js).
// Auth is shared across the project, so our user uids are valid there too.
export const HABIT_FARM_DATABASE_ID = "tcp-rpg";

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, FIRESTORE_DATABASE_ID);
export const habitDb = getFirestore(app, HABIT_FARM_DATABASE_ID);
export const auth = getAuth(app);
