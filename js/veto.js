// veto.js — Map veto (ban/pick) system for a Best-of-3 series.
//
// Each team submits a ballot of PICK_COUNT picks + BAN_COUNT bans, chosen
// independently from the full map pool (both teams may pick/ban the same map).
// A scoring rule then combines both ballots to choose the 3 maps played:
//
//   score(map) = (#teams that picked it) - (#teams that banned it)
//
// The three highest-scoring maps are played, ties broken at random. This means
// maps both teams want rank highest, maps both teams banned rank lowest, and a
// map picked by one team but banned by the other cancels out. Works for any
// pool of at least PICK_COUNT + 1 maps.

import { MAP_POOL } from "./teams.js";

export const PICK_COUNT = 3;
export const BAN_COUNT = 3;
export const MAPS_PLAYED = 3;

function emptyBallot() {
  return { picks: [], bans: [] };
}

// Build a fresh veto state for a match. `userSide` is the side ("A" or "B")
// the human fills in manually; pass null for fully automatic (AI vs AI).
export function createVeto(userSide = null) {
  return {
    userSide,
    ballots: { A: emptyBallot(), B: emptyBallot() },
    log: [],            // [{ type, team, map }] in submission order
    picked: [],         // the MAPS_PLAYED maps to play, in play order
    sideChoice: [],     // per picked map: "A" | "B" | null — who chooses the side
    sides: [],          // per picked map: { sideA, sideB } (CT/T), or null if awaiting the user's choice
    complete: false,
  };
}

// The user's next pending action ({ type, team }), or null when the user's
// ballot is full or the veto is already complete / fully automatic.
export function currentAction(veto) {
  if (veto.complete || !veto.userSide) return null;
  const ballot = veto.ballots[veto.userSide];
  if (ballot.picks.length < PICK_COUNT) return { type: "pick", team: veto.userSide };
  if (ballot.bans.length < BAN_COUNT) return { type: "ban", team: veto.userSide };
  return null;
}

// Maps the user can still choose for their current action: the full pool minus
// the maps they have already picked or banned.
export function userOptions(veto) {
  if (!veto.userSide) return [];
  const ballot = veto.ballots[veto.userSide];
  const taken = new Set([...ballot.picks, ...ballot.bans]);
  return MAP_POOL.filter((m) => !taken.has(m));
}

// Apply the user's current action to `map`. Once the user's ballot is full this
// auto-fills the opponent's ballot and resolves the selection rule.
export function applyVeto(veto, map, rng = Math.random) {
  const action = currentAction(veto);
  if (!action) return veto;
  const ballot = veto.ballots[action.team];
  if (ballot.picks.includes(map) || ballot.bans.includes(map)) return veto;
  if (!MAP_POOL.includes(map)) return veto;

  if (action.type === "pick") ballot.picks.push(map);
  else ballot.bans.push(map);
  veto.log.push({ type: action.type, team: action.team, map });

  finalizeIfReady(veto, rng);
  return veto;
}

// Fill `side`'s ballot with random picks and bans from the remaining pool.
function fillRandomBallot(veto, side, rng = Math.random) {
  const ballot = veto.ballots[side];
  const taken = new Set([...ballot.picks, ...ballot.bans]);
  const avail = shuffle(MAP_POOL.filter((m) => !taken.has(m)), rng);
  const picks = avail.slice(0, PICK_COUNT - ballot.picks.length);
  const bans = avail.slice(picks.length, picks.length + (BAN_COUNT - ballot.bans.length));
  for (const m of picks) {
    ballot.picks.push(m);
    veto.log.push({ type: "pick", team: side, map: m });
  }
  for (const m of bans) {
    ballot.bans.push(m);
    veto.log.push({ type: "ban", team: side, map: m });
  }
}

// Once the user's ballot is full, auto-resolve the opponent and run the rule.
function finalizeIfReady(veto, rng = Math.random) {
  if (veto.complete || currentAction(veto)) return;
  if (veto.userSide) {
    const opp = veto.userSide === "A" ? "B" : "A";
    fillRandomBallot(veto, opp, rng);
  }
  applySelectionRule(veto, rng);
}

// Combine both ballots into the maps played, then resolve starting sides.
//
// Fairness rule: maps both teams picked come first, then the teams' exclusive
// picks are taken one-for-one in alternation so neither team gets two of their
// own picks while the other gets none. Any remaining slots are filled with the
// least-contested leftover maps (highest score). A map a team picked but the
// opponent banned is contested and does not count as an exclusive pick.
function applySelectionRule(veto, rng = Math.random) {
  const { A, B } = veto.ballots;
  const mutual = shuffle(MAP_POOL.filter((m) => A.picks.includes(m) && B.picks.includes(m)), rng);
  const aOnly = shuffle(MAP_POOL.filter((m) => A.picks.includes(m) && !B.picks.includes(m) && !B.bans.includes(m)), rng);
  const bOnly = shuffle(MAP_POOL.filter((m) => B.picks.includes(m) && !A.picks.includes(m) && !A.bans.includes(m)), rng);

  // Alternate exclusive picks between the teams (random first mover).
  const balanced = [];
  const queues = [aOnly.slice(), bOnly.slice()];
  let turn = rng() < 0.5 ? 0 : 1;
  while (queues[0].length || queues[1].length) {
    if (queues[turn].length) balanced.push(queues[turn].shift());
    turn = 1 - turn;
  }

  const chosen = [];
  const used = new Set([...mutual, ...aOnly, ...bOnly]);
  const neutral = shuffle(MAP_POOL.filter((m) => !used.has(m)), rng)
    .sort((x, y) => mapScore(veto, y) - mapScore(veto, x));

  // One pick per team first, then shared maps, then any extra picks, then fill.
  const order = [...balanced.slice(0, 2), ...mutual, ...balanced.slice(2), ...neutral];
  for (const map of order) {
    if (chosen.length >= MAPS_PLAYED) break;
    if (!chosen.includes(map)) chosen.push(map);
  }

  veto.picked = chosen;
  veto.log.push(...veto.picked.map((map) => ({ type: "result", team: null, map })));
  veto.sideChoice = veto.picked.map((map) => sideChoiceFor(veto, map));
  assignSides(veto, rng);
  veto.complete = true;
}

function mapScore(veto, map) {
  const { A, B } = veto.ballots;
  const picks = (A.picks.includes(map) ? 1 : 0) + (B.picks.includes(map) ? 1 : 0);
  const bans = (A.bans.includes(map) ? 1 : 0) + (B.bans.includes(map) ? 1 : 0);
  return picks - bans;
}

// The team entitled to choose the starting side on `map`: the team that did NOT
// pick it. If both teams picked it or neither did, no one has the right (null)
// and sides are assigned at random.
function sideChoiceFor(veto, map) {
  const pickedByA = veto.ballots.A.picks.includes(map);
  const pickedByB = veto.ballots.B.picks.includes(map);
  if (pickedByA && !pickedByB) return "B";
  if (pickedByB && !pickedByA) return "A";
  return null;
}

// Assign starting sides (CT/T) to each picked map. A map whose side choice
// belongs to the user is left null so the user can pick it via the UI; every
// other map (opponent's choice or no entitlement) is assigned at random.
function assignSides(veto, rng = Math.random) {
  veto.sides = veto.picked.map((map, i) => {
    if (veto.sideChoice[i] && veto.sideChoice[i] === veto.userSide) return null;
    const sideA = rng() < 0.5 ? "CT" : "T";
    return { sideA, sideB: sideA === "CT" ? "T" : "CT" };
  });
}

// Record the user's starting-side choice for a picked map. `side` is the CT/T
// the user's own team will start on. No-op unless the user holds the right.
export function chooseSide(veto, mapIndex, side) {
  if (!veto.userSide) return veto;
  if (mapIndex < 0 || mapIndex >= veto.picked.length) return veto;
  if (veto.sideChoice[mapIndex] !== veto.userSide) return veto;
  if (side !== "CT" && side !== "T") return veto;
  const other = side === "CT" ? "T" : "CT";
  veto.sides[mapIndex] = veto.userSide === "A"
    ? { sideA: side, sideB: other }
    : { sideA: other, sideB: side };
  return veto;
}

// Whether the user still needs to choose a starting side for picked map `i`.
export function needsUserSide(veto, i) {
  if (!veto || !veto.sideChoice) return false;
  return veto.sideChoice[i] === veto.userSide && !veto.sides[i];
}

// Fisher-Yates shuffle returning a new array.
function shuffle(arr, rng = Math.random) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Auto-resolve the adversary up to the user's next turn. With ballots this is a
// no-op until the user's ballot is full, at which point applyVeto already
// finalized; kept for call-site compatibility.
export function autoVetoOpponent(veto, _userSide, rng = Math.random) {
  finalizeIfReady(veto, rng);
  return veto;
}

// Run the whole veto automatically (AI vs AI / quick play).
export function autoVeto(rng = Math.random) {
  const veto = createVeto(null);
  fillRandomBallot(veto, "A", rng);
  fillRandomBallot(veto, "B", rng);
  applySelectionRule(veto, rng);
  return veto;
}
