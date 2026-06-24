// veto.js — Map veto (ban/pick) system for a Best-of-3 series.
//
// Standard CS2 BO3 sequence over the 7-map pool:
//   1. A ban   2. B ban   3. A pick   4. B pick   5. A ban   6. B ban   7. decider
// Result: 3 maps played (A's pick, B's pick, the decider).

import { MAP_POOL } from "./teams.js";

// Sequence of actions. `team` is "A" or "B"; the decider has no team.
export const VETO_SEQUENCE = [
  { type: "ban", team: "A" },
  { type: "ban", team: "B" },
  { type: "pick", team: "A" },
  { type: "pick", team: "B" },
  { type: "ban", team: "A" },
  { type: "ban", team: "B" },
  { type: "decider", team: null },
];

// Build a fresh veto state for a match.
export function createVeto() {
  return {
    pool: [...MAP_POOL],   // maps still available
    step: 0,               // index into VETO_SEQUENCE
    log: [],               // [{ type, team, map }]
    picked: [],            // maps that will be played, in play order
    sides: [],             // per picked map: { sideA, sideB } (CT/T), set on completion
    complete: false,
  };
}

// Randomly assign starting sides (CT/T) to each picked map once veto is done.
function assignSides(veto, rng = Math.random) {
  veto.sides = veto.picked.map(() => {
    const sideA = rng() < 0.5 ? "CT" : "T";
    return { sideA, sideB: sideA === "CT" ? "T" : "CT" };
  });
}

export function currentAction(veto) {
  if (veto.complete) return null;
  return VETO_SEQUENCE[veto.step] || null;
}

// Apply the current veto action to `map`. Returns the mutated veto.
export function applyVeto(veto, map, rng = Math.random) {
  const action = currentAction(veto);
  if (!action) return veto;
  if (!veto.pool.includes(map)) return veto;

  veto.pool = veto.pool.filter((m) => m !== map);
  veto.log.push({ type: action.type, team: action.team, map });
  if (action.type === "pick") veto.picked.push(map);

  veto.step += 1;
  advanceDecider(veto, rng);
  return veto;
}

// When only the decider step remains, auto-assign the last map.
function advanceDecider(veto, rng = Math.random) {
  const action = VETO_SEQUENCE[veto.step];
  if (action && action.type === "decider" && veto.pool.length === 1) {
    const decider = veto.pool[0];
    veto.pool = [];
    veto.log.push({ type: "decider", team: null, map: decider });
    veto.picked.push(decider);
    veto.step += 1;
  }
  if (veto.step >= VETO_SEQUENCE.length) {
    veto.complete = true;
    assignSides(veto, rng);
  }
}

// Pick a random remaining map (used to auto-veto for AI / quick play).
export function randomVetoChoice(veto, rng = Math.random) {
  if (!veto.pool.length) return null;
  return veto.pool[Math.floor(rng() * veto.pool.length)];
}

// Run the whole veto automatically and return the completed state.
export function autoVeto(rng = Math.random) {
  const veto = createVeto();
  while (!veto.complete) {
    const choice = randomVetoChoice(veto, rng);
    if (choice == null) break;
    applyVeto(veto, choice, rng);
  }
  return veto;
}

// Auto-resolve the adversary's bans/picks with random map choices, stopping as
// soon as it's `userSide`'s turn (or the veto completes). The user's own side
// is never auto-applied — those steps are always made manually. `userSide` is
// "A" or "B"; pass null to auto-resolve the entire veto.
export function autoVetoOpponent(veto, userSide, rng = Math.random) {
  while (!veto.complete) {
    const action = currentAction(veto);
    if (!action) break;
    // Wait for manual input on the user's turn. The decider (team === null) is
    // assigned automatically inside applyVeto, so it never surfaces here.
    if (action.team === userSide || action.team == null) break;
    const choice = randomVetoChoice(veto, rng);
    if (choice == null) break;
    applyVeto(veto, choice, rng);
  }
  return veto;
}
