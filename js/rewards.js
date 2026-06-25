// rewards.js — cross-app integration with Habit Farm.
//
// When the user's CS team wins a championship, we grant the signed-in user a
// reward in Habit Farm's store. Habit Farm lives in the same Firebase project
// but a different named Firestore database ("tcp-rpg"); Auth is shared, so our
// user's uid is also their Habit Farm uid.
//
// We write directly from the client (no backend). Habit Farm's security rules
// permit a user to create a reward for THEMSELVES (userId == auth.uid), so each
// member self-grants their own reward — we cannot grant other members' rewards
// from the client. The reward doc id is deterministic per (championship, user),
// so re-granting is a harmless idempotent upsert (no duplicates on re-open).
//
// See EXTERNAL_REWARDS_INTEGRATION.md for the contract (database name, doc
// shape, the "appears on next Habit Farm load" caveat, etc.).

import { habitDb, auth } from "./firebase.js";
import { doc, setDoc } from "firebase/firestore";

// Coin price of the champion reward in the Habit Farm store (a meaningful
// purchase — redeeming still costs the user this many Coins).
const CHAMPION_REWARD_COST = 100;

// Grant the current user the champion reward for `championshipId`. `teamName` is
// the winning CS roster's display name. Idempotent. Resolves the reward id, or
// null if there's no signed-in user. Throws on a write failure (callers treat
// it as best-effort).
export async function grantChampionReward(championshipId, teamName) {
  const u = auth.currentUser;
  if (!u || !championshipId) return null;
  const id = `xreward_cs2camp_${championshipId}_${u.uid}`;
  const reward = {
    id,                               // MUST equal the doc id (Habit Farm keys docs by id)
    userId: u.uid,                    // recipient = self (shared-project uid)
    kind: "cs2",                      // Habit Farm's built-in CS2 reward kind
    title: `🏆 CS2 Champion — ${teamName || "Winner"}`,
    description: "Awarded for winning a championship in the CS2 Championship Organizer.",
    cost: CHAMPION_REWARD_COST,       // positive integer Coins
    createdBy: "cs2camp",             // audit trail (owner-create branch ignores this)
  };
  await setDoc(doc(habitDb, "rewards", id), reward);
  return id;
}
