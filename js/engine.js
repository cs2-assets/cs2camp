// engine.js — Tournament generation, group stage, playoff bracket, match
// simulation and winner propagation.
//
// Multiple championship formats are supported (see FORMATS); all share the same
// match/series model (BO3) and the "user only plays their own team's matches,
// everything else auto-resolves" simulation.

import { TEAMS } from "./teams.js";
import { autoVeto } from "./veto.js";

// ---- Format constants ----------------------------------------------------

export const GROUP_COUNT = 8;       // groups (groups format)
export const GROUP_SIZE = 4;        // teams per group (groups format)
export const ADVANCE_PER_GROUP = 2; // top N of each group advance
export const FIELD_SIZE = GROUP_COUNT * GROUP_SIZE;        // 32 teams total
export const BRACKET_SIZE = GROUP_COUNT * ADVANCE_PER_GROUP; // 16 playoff teams

// Selectable championship formats. `field` is the total number of teams.
export const FORMATS = {
  groups: {
    key: "groups", label: "Groups → Playoffs", field: 32,
    blurb: "8 groups of 4 (round-robin). Top 2 of each advance to a 16-team single-elimination bracket.",
  },
  single: {
    key: "single", label: "Single Elimination", field: 16,
    blurb: "16 teams, one knockout bracket. Lose a series and you're out.",
  },
  league: {
    key: "league", label: "Round Robin League", field: 8,
    blurb: "8 teams, everyone plays everyone once. Top of the final table is champion — no playoffs.",
  },
  swiss: {
    key: "swiss", label: "Swiss → Playoffs", field: 16,
    blurb: "CS Major-style. 16 teams paired by record; 3 wins qualify, 3 losses eliminate. The 8 qualifiers play a single-elim bracket.",
  },
  double: {
    key: "double", label: "Double Elimination", field: 8,
    blurb: "8 teams, winners & losers brackets. Lose once and you drop to the lower bracket; lose twice and you're out.",
  },
};
export const DEFAULT_FORMAT = "groups";

// Playoff round stage keys (for the 16-team bracket used by groups/single).
export const STAGES = ["ro16", "quarter", "semi", "final"];
export const STAGE_LABELS = {
  group: "Group Stage",
  league: "League",
  swiss: "Swiss Stage",
  playoff: "Playoffs",
  champion: "Champion",
  ro32: "Round of 32",
  ro16: "Round of 16",
  quarter: "Quarterfinals",
  semi: "Semifinals",
  final: "Grand Final",
};

// Stage keys for an N-round single-elimination bracket, e.g. 4 rounds ->
// ["ro16","quarter","semi","final"], 3 rounds -> ["quarter","semi","final"].
const STAGE_SUFFIX = ["final", "semi", "quarter", "ro16", "ro32", "ro64"];
export function stageKeysForRounds(n) {
  return STAGE_SUFFIX.slice(0, n).reverse();
}

// Group letter for a group index (0 -> "A").
export function groupLetter(idx) {
  return String.fromCharCode(65 + idx);
}

// All round-robin pairings (index pairs) for n teams.
function roundRobinPairs(n) {
  const pairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) pairs.push([i, j]);
  }
  return pairs;
}

// Round-robin pairings for a group of GROUP_SIZE teams (6 matches for 4 teams).
const ROUND_ROBIN_PAIRS = roundRobinPairs(GROUP_SIZE);

// Fisher-Yates shuffle (unbiased, unlike Array.sort).
function shuffle(array, rng = Math.random) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- Match construction --------------------------------------------------

function playoffMatch(round, index) {
  return {
    id: `r${round}-m${index}`,
    round,
    index,
    stage: STAGES[round],
    teamA: null,
    teamB: null,
    veto: null,
    mapsPlayed: [],
    winnerId: null,
    status: "pending", // pending | live | finished
  };
}

function groupMatch(groupIdx, index, teamA, teamB, stage = "group") {
  return {
    id: `g${groupIdx}-m${index}`,
    groupIdx,
    index,
    stage,
    teamA,
    teamB,
    veto: null,
    mapsPlayed: [],
    winnerId: null,
    status: "live", // group/league matches are all immediately playable
  };
}

// Build the full empty playoff bracket tree for `size` teams.
function buildEmptyRounds(size) {
  const rounds = [];
  let matchCount = size / 2;
  let round = 0;
  while (matchCount >= 1) {
    const matches = [];
    for (let i = 0; i < matchCount; i++) matches.push(playoffMatch(round, i));
    rounds.push(matches);
    matchCount = Math.floor(matchCount / 2);
    round += 1;
  }
  return rounds;
}

// ---- Tournament generation -----------------------------------------------

// Build the field: the selected team + (size-1) random opponents, shuffled.
function pickField(selectedTeamId, size, rng) {
  const selected = TEAMS.find((t) => t.id === selectedTeamId);
  if (!selected) throw new Error("Unknown team: " + selectedTeamId);
  const opponents = shuffle(TEAMS.filter((t) => t.id !== selectedTeamId), rng).slice(0, size - 1);
  return shuffle([selected, ...opponents], rng);
}

// generateTournament(selectedTeam, format) — main entry point. Dispatches on
// the chosen format and auto-resolves everything not involving the user.
export function generateTournament(selectedTeamId, format = DEFAULT_FORMAT, rng = Math.random) {
  const cfg = FORMATS[format] || FORMATS[DEFAULT_FORMAT];
  const field = pickField(selectedTeamId, cfg.field, rng);

  let tournament;
  if (cfg.key === "single") tournament = buildSingleElim(selectedTeamId, field);
  else if (cfg.key === "league") tournament = buildLeague(selectedTeamId, field);
  else if (cfg.key === "swiss") tournament = buildSwiss(selectedTeamId, field, rng);
  else if (cfg.key === "double") tournament = buildDouble(selectedTeamId, field);
  else tournament = buildGroups(selectedTeamId, field);

  // Resolve every match that does not involve the user's team right away so the
  // user only ever has to play their own path (and the rest plays out if the
  // user is eliminated).
  resolveAiMatches(tournament, rng);
  return tournament;
}

// Groups → single-elim playoffs (8 groups of 4 → 16-team bracket).
function buildGroups(selectedTeamId, field) {
  const groups = [];
  for (let g = 0; g < GROUP_COUNT; g++) {
    const members = field.slice(g * GROUP_SIZE, g * GROUP_SIZE + GROUP_SIZE);
    const matches = ROUND_ROBIN_PAIRS.map(([i, j], k) =>
      groupMatch(g, k, members[i], members[j])
    );
    groups.push({ idx: g, name: `Group ${groupLetter(g)}`, teamIds: members.map((t) => t.id), matches });
  }
  return {
    format: "groups",
    selectedTeamId,
    teams: field,
    groups,
    rounds: buildEmptyRounds(BRACKET_SIZE), // empty until the group stage ends
    stages: stageKeysForRounds(Math.log2(BRACKET_SIZE)),
    phase: "group",
    currentStage: "group",
    champion: null,
  };
}

// Single-elimination knockout: the whole field seeded straight into round 0.
function buildSingleElim(selectedTeamId, field) {
  const rounds = buildEmptyRounds(field.length);
  const stages = stageKeysForRounds(rounds.length);
  rounds.forEach((rd, ri) => rd.forEach((m) => { m.stage = stages[ri]; }));
  const r0 = rounds[0];
  for (let i = 0; i < r0.length; i++) {
    r0[i].teamA = field[2 * i];
    r0[i].teamB = field[2 * i + 1];
    r0[i].status = "live";
  }
  return {
    format: "single",
    selectedTeamId,
    teams: field,
    groups: [],
    rounds,
    stages,
    phase: "playoff",
    currentStage: stages[0],
    champion: null,
  };
}

// Round-robin league: one table, everyone plays everyone once, no playoffs.
function buildLeague(selectedTeamId, field) {
  const matches = roundRobinPairs(field.length).map(([i, j], k) =>
    groupMatch(0, k, field[i], field[j], "league")
  );
  return {
    format: "league",
    selectedTeamId,
    teams: field,
    groups: [{ idx: 0, name: "League Table", teamIds: field.map((t) => t.id), matches }],
    rounds: [],
    stages: [],
    phase: "group",
    currentStage: "league",
    champion: null,
  };
}

// ---- Swiss-stage format --------------------------------------------------

const SWISS_WINS = 3;   // wins to qualify
const SWISS_LOSSES = 3; // losses to be eliminated

function swissMatch(roundIdx, index, teamA, teamB) {
  return {
    id: `s${roundIdx}-m${index}`,
    swissRound: roundIdx,
    index,
    stage: "swiss",
    stageLabel: `Swiss · Round ${roundIdx + 1}`,
    teamA, teamB, veto: null, mapsPlayed: [], winnerId: null,
    status: "live",
  };
}

// Pair team ids two-by-two, preferring partners they haven't faced yet; falls
// back to a rematch only if unavoidable. Always returns a complete pairing for
// an even-sized list.
function pairTeams(ids, opponents, rng = Math.random) {
  const order = shuffle(ids, rng);
  const result = [];
  const seen = (a, b) => (opponents[a] || []).includes(b);
  function backtrack(remaining) {
    if (!remaining.length) return true;
    const a = remaining[0];
    const rest = remaining.slice(1);
    const fresh = rest.filter((b) => !seen(a, b));
    const repeat = rest.filter((b) => seen(a, b));
    for (const b of [...fresh, ...repeat]) {
      result.push([a, b]);
      if (backtrack(rest.filter((x) => x !== b))) return true;
      result.pop();
    }
    return false;
  }
  backtrack(order);
  return result;
}

// Swiss → single-elim playoffs (16 teams; 3 wins qualify, 3 losses eliminate;
// the 8 qualifiers seed an 8-team bracket).
function buildSwiss(selectedTeamId, field, rng) {
  const records = {}, opponents = {};
  field.forEach((t) => { records[t.id] = { w: 0, l: 0 }; opponents[t.id] = []; });
  const byId = (id) => field.find((t) => t.id === id);
  const r0 = pairTeams(field.map((t) => t.id), opponents, rng)
    .map(([a, b], i) => swissMatch(0, i, byId(a), byId(b)));
  return {
    format: "swiss",
    selectedTeamId,
    teams: field,
    groups: [],
    rounds: [],          // playoff bracket, seeded once the Swiss stage ends
    stages: [],
    swiss: { records, opponents, rounds: [r0], qualified: [], eliminated: [] },
    phase: "swiss",
    currentStage: "swiss",
    champion: null,
  };
}

// Recompute every team's W-L record and opponent history from the Swiss matches.
function recomputeSwiss(tournament) {
  const sw = tournament.swiss;
  for (const id in sw.records) { sw.records[id] = { w: 0, l: 0 }; sw.opponents[id] = []; }
  for (const round of sw.rounds) {
    for (const m of round) {
      if (!m.teamA || !m.teamB) continue;
      sw.opponents[m.teamA.id].push(m.teamB.id);
      sw.opponents[m.teamB.id].push(m.teamA.id);
      if (m.status === "finished" && m.winnerId) {
        const loserId = m.teamA.id === m.winnerId ? m.teamB.id : m.teamA.id;
        sw.records[m.winnerId].w++;
        sw.records[loserId].l++;
      }
    }
  }
  sw.qualified = tournament.teams.map((t) => t.id).filter((id) => sw.records[id].w >= SWISS_WINS);
  sw.eliminated = tournament.teams.map((t) => t.id).filter((id) => sw.records[id].l >= SWISS_LOSSES);
}

// After a Swiss round completes: generate the next round (pairing within each
// W-L bucket) or, once every team is decided, seed the playoff bracket.
function advanceSwiss(tournament, rng) {
  const sw = tournament.swiss;
  recomputeSwiss(tournament);
  const active = tournament.teams.map((t) => t.id)
    .filter((id) => sw.records[id].w < SWISS_WINS && sw.records[id].l < SWISS_LOSSES);

  if (!active.length) { seedSwissPlayoffs(tournament); return true; }

  const buckets = {};
  for (const id of active) {
    const k = `${sw.records[id].w}-${sw.records[id].l}`;
    (buckets[k] = buckets[k] || []).push(id);
  }
  const roundIdx = sw.rounds.length;
  const byId = (id) => teamById(tournament, id);
  const matches = [];
  let mi = 0;
  for (const k of Object.keys(buckets)) {
    for (const [a, b] of pairTeams(buckets[k], sw.opponents, rng)) {
      matches.push(swissMatch(roundIdx, mi++, byId(a), byId(b)));
    }
  }
  sw.rounds.push(matches);
  return true;
}

// Seed the 8 Swiss qualifiers into an 8-team single-elim bracket. Better records
// (fewer losses) get the higher seeds; standard bracket slotting keeps the top
// two seeds apart until the final.
function seedSwissPlayoffs(tournament) {
  const sw = tournament.swiss;
  const seeds = sw.qualified.slice().sort((a, b) => sw.records[a].l - sw.records[b].l);
  const rounds = buildEmptyRounds(8);
  const stages = stageKeysForRounds(rounds.length);
  rounds.forEach((rd, ri) => rd.forEach((m) => { m.stage = stages[ri]; }));
  const order = [0, 7, 3, 4, 1, 6, 2, 5];
  const slots = order.map((i) => seeds[i]);
  const r0 = rounds[0];
  for (let i = 0; i < r0.length; i++) {
    r0[i].teamA = teamById(tournament, slots[2 * i]);
    r0[i].teamB = teamById(tournament, slots[2 * i + 1]);
    if (r0[i].teamA && r0[i].teamB) r0[i].status = "live";
  }
  tournament.rounds = rounds;
  tournament.stages = stages;
  tournament.phase = "playoff";
  tournament.currentStage = stages[0];
}

// ---- Double-elimination format -------------------------------------------

function deMatch(id, stageLabel, live = false) {
  return {
    id, stage: "de", stageLabel,
    teamA: null, teamB: null, veto: null, mapsPlayed: [], winnerId: null,
    status: live ? "live" : "pending",
  };
}

// Loser/winner routing for the fixed 8-team double-elim bracket. Each entry maps
// a finished match to where its winner and loser go ([matchId, slot] | "champion" | "out").
const DE_ROUTES = {
  "wb-r1-m0": { win: ["wb-r2-m0", "A"], lose: ["lb-r1-m0", "A"] },
  "wb-r1-m1": { win: ["wb-r2-m0", "B"], lose: ["lb-r1-m0", "B"] },
  "wb-r1-m2": { win: ["wb-r2-m1", "A"], lose: ["lb-r1-m1", "A"] },
  "wb-r1-m3": { win: ["wb-r2-m1", "B"], lose: ["lb-r1-m1", "B"] },
  "wb-r2-m0": { win: ["wb-r3-m0", "A"], lose: ["lb-r2-m1", "B"] },
  "wb-r2-m1": { win: ["wb-r3-m0", "B"], lose: ["lb-r2-m0", "B"] },
  "wb-r3-m0": { win: ["gf", "A"], lose: ["lb-r4-m0", "B"] },
  "lb-r1-m0": { win: ["lb-r2-m0", "A"], lose: "out" },
  "lb-r1-m1": { win: ["lb-r2-m1", "A"], lose: "out" },
  "lb-r2-m0": { win: ["lb-r3-m0", "A"], lose: "out" },
  "lb-r2-m1": { win: ["lb-r3-m0", "B"], lose: "out" },
  "lb-r3-m0": { win: ["lb-r4-m0", "A"], lose: "out" },
  "lb-r4-m0": { win: ["gf", "B"], lose: "out" },
  "gf": { win: "champion", lose: "out" },
};

function buildDouble(selectedTeamId, field) {
  const wb = [
    [deMatch("wb-r1-m0", "Winners · Round 1", true), deMatch("wb-r1-m1", "Winners · Round 1", true),
     deMatch("wb-r1-m2", "Winners · Round 1", true), deMatch("wb-r1-m3", "Winners · Round 1", true)],
    [deMatch("wb-r2-m0", "Winners · Semifinal"), deMatch("wb-r2-m1", "Winners · Semifinal")],
    [deMatch("wb-r3-m0", "Winners · Final")],
  ];
  const lb = [
    [deMatch("lb-r1-m0", "Losers · Round 1"), deMatch("lb-r1-m1", "Losers · Round 1")],
    [deMatch("lb-r2-m0", "Losers · Round 2"), deMatch("lb-r2-m1", "Losers · Round 2")],
    [deMatch("lb-r3-m0", "Losers · Round 3")],
    [deMatch("lb-r4-m0", "Losers · Final")],
  ];
  const gf = deMatch("gf", "Grand Final");
  // Seed the winners' round 1 with the whole field.
  wb[0].forEach((m, i) => { m.teamA = field[2 * i]; m.teamB = field[2 * i + 1]; });
  return {
    format: "double",
    selectedTeamId,
    teams: field,
    groups: [],
    rounds: [],
    stages: [],
    de: { wb, lb, gf },
    phase: "playoff",
    currentStage: "winners",
    champion: null,
  };
}

// All double-elim matches, flat.
export function deAllMatches(tournament) {
  if (!tournament.de) return [];
  return [...tournament.de.wb.flat(), ...tournament.de.lb.flat(), tournament.de.gf];
}

function findDeMatch(tournament, id) {
  return deAllMatches(tournament).find((m) => m.id === id) || null;
}

function placeDe(tournament, target, team) {
  if (!target || target === "out") return;
  if (target === "champion") { tournament.champion = team; return; }
  const [id, slot] = target;
  const m = findDeMatch(tournament, id);
  if (!m || !team) return;
  if (slot === "A") m.teamA = team; else m.teamB = team;
  if (m.teamA && m.teamB && m.status === "pending") m.status = "live";
}

// Route a finished double-elim match's winner and loser to their next slots.
function advanceDouble(tournament, match) {
  if (match.status !== "finished" || !match.winnerId) return;
  const route = DE_ROUTES[match.id];
  if (!route) return;
  const winner = teamById(tournament, match.winnerId);
  const loserId = match.teamA.id === match.winnerId ? match.teamB.id : match.teamA.id;
  placeDe(tournament, route.win, winner);
  placeDe(tournament, route.lose, teamById(tournament, loserId));
}

// ---- Match lookup helpers ------------------------------------------------

export function findMatch(tournament, matchId) {
  if (tournament.groups) {
    for (const group of tournament.groups) {
      const m = group.matches.find((x) => x.id === matchId);
      if (m) return m;
    }
  }
  for (const round of tournament.rounds) {
    const m = round.find((x) => x.id === matchId);
    if (m) return m;
  }
  if (tournament.swiss) {
    for (const round of tournament.swiss.rounds) {
      const m = round.find((x) => x.id === matchId);
      if (m) return m;
    }
  }
  if (tournament.de) {
    const m = deAllMatches(tournament).find((x) => x.id === matchId);
    if (m) return m;
  }
  return null;
}

export function teamById(tournament, id) {
  return tournament.teams.find((t) => t.id === id) || null;
}

// A match is ready to play once both slots are filled and it is not finished.
export function isPlayable(match) {
  return match.teamA && match.teamB && match.status !== "finished";
}

// True when the user's selected team is one of the two competitors.
export function involvesUser(tournament, match) {
  const id = tournament.selectedTeamId;
  return (match.teamA && match.teamA.id === id) || (match.teamB && match.teamB.id === id);
}

// ---- Scoring -------------------------------------------------------------

function seriesScore(match) {
  let a = 0;
  let b = 0;
  for (const m of match.mapsPlayed) {
    if (m.winnerId === match.teamA.id) a++;
    else if (m.winnerId === match.teamB.id) b++;
  }
  return { a, b };
}

// Record a single map result. Returns true if it completed the series.
// Starting sides (CT/T) come from the sides chosen at veto completion; if a
// map has no pre-assigned side, fall back to a random pick.
export function recordMap(match, mapName, scoreA, scoreB, rng = Math.random) {
  if (match.status === "finished") return false;
  const winnerId = scoreA > scoreB ? match.teamA.id : match.teamB.id;
  const idx = match.mapsPlayed.length;
  let sides = match.veto && match.veto.sides && match.veto.sides[idx];
  if (!sides) {
    const sideA = rng() < 0.5 ? "CT" : "T";
    sides = { sideA, sideB: sideA === "CT" ? "T" : "CT" };
  }
  match.mapsPlayed.push({ map: mapName, scoreA, scoreB, winnerId, sideA: sides.sideA, sideB: sides.sideB });
  match.status = "live";
  return maybeFinish(match);
}

// BO3 completion: first to 2 map wins.
function maybeFinish(match) {
  const { a, b } = seriesScore(match);
  if (a >= 2 || b >= 2) {
    match.winnerId = a > b ? match.teamA.id : match.teamB.id;
    match.status = "finished";
    return true;
  }
  return false;
}

// ---- Group standings -----------------------------------------------------

// Compute the standings for one group from its finished matches.
// Ranked by: series wins, then map differential, then round differential.
// Returns an array of stat objects in finishing order (best first).
export function computeStandings(tournament, group) {
  const stats = {};
  for (const id of group.teamIds) {
    stats[id] = {
      teamId: id,
      played: 0,
      wins: 0,
      losses: 0,
      mapsWon: 0,
      mapsLost: 0,
      roundsWon: 0,
      roundsLost: 0,
    };
  }

  for (const m of group.matches) {
    if (m.status !== "finished" || !m.teamA || !m.teamB) continue;
    const aId = m.teamA.id;
    const bId = m.teamB.id;
    let aMaps = 0, bMaps = 0, aRounds = 0, bRounds = 0;
    for (const mp of m.mapsPlayed) {
      aRounds += mp.scoreA;
      bRounds += mp.scoreB;
      if (mp.winnerId === aId) aMaps++; else bMaps++;
    }
    const A = stats[aId], B = stats[bId];
    A.played++; B.played++;
    A.mapsWon += aMaps; A.mapsLost += bMaps;
    B.mapsWon += bMaps; B.mapsLost += aMaps;
    A.roundsWon += aRounds; A.roundsLost += bRounds;
    B.roundsWon += bRounds; B.roundsLost += aRounds;
    if (m.winnerId === aId) { A.wins++; B.losses++; }
    else { B.wins++; A.losses++; }
  }

  return group.teamIds
    .map((id) => stats[id])
    .sort(
      (x, y) =>
        y.wins - x.wins ||
        (y.mapsWon - y.mapsLost) - (x.mapsWon - x.mapsLost) ||
        (y.roundsWon - y.roundsLost) - (x.roundsWon - x.roundsLost)
    );
}

// True once every group match across all groups is finished.
export function groupStageComplete(tournament) {
  return tournament.groups.every((g) => g.matches.every((m) => m.status === "finished"));
}

// ---- AI auto-resolution --------------------------------------------------
// The user only plays matches involving their own team. Every other match is
// resolved automatically with a random veto and random map scores.

// Random CS2 map score. First to 13, with an occasional overtime finish.
function randomMapScore(rng = Math.random) {
  const aWins = rng() < 0.5;
  const overtime = rng() < 0.25;
  let win, lose;
  if (overtime) {
    win = 16;
    lose = 13 + Math.floor(rng() * 2); // 13 or 14
  } else {
    win = 13;
    lose = Math.floor(rng() * 12); // 0..11
  }
  return aWins ? { scoreA: win, scoreB: lose } : { scoreA: lose, scoreB: win };
}

// Fully resolve a single match: auto-veto the maps, then play random scores
// until one team reaches 2 map wins.
function autoResolveMatch(match, rng = Math.random) {
  if (match.status === "finished" || !match.teamA || !match.teamB) return;
  if (!match.veto || !match.veto.complete) match.veto = autoVeto(rng);
  if (match.status === "pending") match.status = "live";

  let guard = 0;
  while (match.status !== "finished" && guard < 10) {
    const mapName = match.veto.picked[match.mapsPlayed.length];
    if (!mapName) break;
    const { scoreA, scoreB } = randomMapScore(rng);
    recordMap(match, mapName, scoreA, scoreB, rng);
    guard++;
  }
}

// Seed the playoff bracket (Ro16) from the final group standings. Groups are
// paired up (A/B, C/D, ...) so the two qualifiers from a group cannot meet
// again until later: 1st of one group faces 2nd of its paired group.
export function seedPlayoffs(tournament) {
  if (tournament.phase !== "group" || !groupStageComplete(tournament)) return;

  const standings = tournament.groups.map((g) => computeStandings(tournament, g));
  const ro16 = tournament.rounds[0];

  for (let p = 0; p < tournament.groups.length; p += 2) {
    const gA = standings[p];      // e.g. Group A
    const gB = standings[p + 1];  // e.g. Group B
    const m0 = ro16[p];           // A1 vs B2
    const m1 = ro16[p + 1];       // B1 vs A2
    m0.teamA = teamById(tournament, gA[0].teamId);
    m0.teamB = teamById(tournament, gB[1].teamId);
    m0.status = "live";
    m1.teamA = teamById(tournament, gB[0].teamId);
    m1.teamB = teamById(tournament, gA[1].teamId);
    m1.status = "live";
  }

  tournament.phase = "playoff";
  tournament.currentStage = "ro16";
}

// Resolve every playable match that does not involve the user's team, cascading
// winners forward, until the whole tournament is stable. Dispatches per format.
export function resolveAiMatches(tournament, rng = Math.random) {
  let changed = true;
  let guard = 0;
  while (changed && guard < 300) {
    guard++;
    if (tournament.format === "swiss") changed = resolveSwiss(tournament, rng);
    else if (tournament.format === "double") changed = resolveDouble(tournament, rng);
    else changed = resolveStandard(tournament, rng);
  }
  updateCurrentStage(tournament);
}

// Auto-resolve a list of bracket-style matches, propagating each winner.
function resolveBracket(tournament, matches, rng) {
  let changed = false;
  for (const m of matches) {
    if (m.status === "finished" || !m.teamA || !m.teamB) continue;
    if (involvesUser(tournament, m)) continue;
    autoResolveMatch(m, rng);
    if (m.status === "finished") { advanceWinner(tournament, m); changed = true; }
  }
  return changed;
}

// groups / single / league: group stage (round-robin) then single-elim bracket.
function resolveStandard(tournament, rng) {
  let changed = false;
  if (tournament.phase === "group") {
    for (const group of tournament.groups) {
      for (const m of group.matches) {
        if (m.status === "finished" || !m.teamA || !m.teamB) continue;
        if (involvesUser(tournament, m)) continue;
        autoResolveMatch(m, rng);
        if (m.status === "finished") changed = true;
      }
    }
    if (groupStageComplete(tournament)) {
      if (tournament.format === "league") finishLeague(tournament);
      else seedPlayoffs(tournament);
      changed = true;
    }
  }
  if (tournament.phase === "playoff") {
    for (const round of tournament.rounds) changed = resolveBracket(tournament, round, rng) || changed;
  }
  return changed;
}

// swiss: resolve the current round, then generate the next round / seed playoffs.
function resolveSwiss(tournament, rng) {
  let changed = false;
  if (tournament.phase === "swiss") {
    const sw = tournament.swiss;
    const round = sw.rounds[sw.rounds.length - 1];
    for (const m of round) {
      if (m.status === "finished" || !m.teamA || !m.teamB) continue;
      if (involvesUser(tournament, m)) continue;
      autoResolveMatch(m, rng);
      if (m.status === "finished") changed = true;
    }
    if (round.every((m) => m.status === "finished")) changed = advanceSwiss(tournament, rng) || changed;
  }
  if (tournament.phase === "playoff") {
    for (const round of tournament.rounds) changed = resolveBracket(tournament, round, rng) || changed;
  }
  return changed;
}

// double: resolve any playable winners/losers/grand-final match.
function resolveDouble(tournament, rng) {
  return resolveBracket(tournament, deAllMatches(tournament), rng);
}

// ---- Winner propagation --------------------------------------------------

// Place a finished playoff match's winner into its next-round slot and unlock
// it. Group matches have no `round` and do not propagate here — they feed the
// bracket through seedPlayoffs() once the group stage is complete.
export function advanceWinner(tournament, match) {
  // Double-elim has its own winner/loser routing.
  if (tournament.format === "double") return advanceDouble(tournament, match);
  // Group/league and Swiss-stage matches don't propagate through `rounds`
  // (groups seed via seedPlayoffs; Swiss progresses in the resolver). Only
  // bracket matches carry a numeric `round`.
  if (typeof match.round !== "number") return;
  if (match.status !== "finished" || !match.winnerId) return;
  const winner = teamById(tournament, match.winnerId);

  const nextRound = match.round + 1;
  if (nextRound >= tournament.rounds.length) {
    tournament.champion = winner;
    tournament.currentStage = "final";
    return;
  }

  const nextMatch = tournament.rounds[nextRound][Math.floor(match.index / 2)];
  if (match.index % 2 === 0) nextMatch.teamA = winner;
  else nextMatch.teamB = winner;

  if (nextMatch.teamA && nextMatch.teamB && nextMatch.status === "pending") {
    nextMatch.status = "live";
  }
  updateCurrentStage(tournament);
}

// Crown the league winner once every league match is played.
function finishLeague(tournament) {
  const standings = computeStandings(tournament, tournament.groups[0]);
  if (standings.length) tournament.champion = teamById(tournament, standings[0].teamId);
  tournament.phase = "done";
  tournament.currentStage = "champion";
}

// currentStage = "group"/"league" until that phase ends, otherwise the earliest
// playoff round that still has an unfinished match.
export function updateCurrentStage(tournament) {
  const stages = (tournament.stages && tournament.stages.length) ? tournament.stages : STAGES;
  if (tournament.format === "league") {
    tournament.currentStage = groupStageComplete(tournament) ? "champion" : "league";
    return;
  }
  if (tournament.format === "double") {
    tournament.currentStage = tournament.champion ? "champion" : "playoff";
    return;
  }
  if (tournament.format === "swiss" && tournament.phase === "swiss") {
    tournament.currentStage = "swiss";
    return;
  }
  if (tournament.phase === "group" && !groupStageComplete(tournament)) {
    tournament.currentStage = "group";
    return;
  }
  for (let r = 0; r < tournament.rounds.length; r++) {
    if (tournament.rounds[r].some((m) => m.status !== "finished")) {
      tournament.currentStage = stages[r];
      return;
    }
  }
  tournament.currentStage = stages[stages.length - 1] || "final";
}
