// engine.js — Tournament generation, group stage, playoff bracket, match
// simulation and winner propagation.
//
// Format:
//   * 32 teams (the user's team + 31 random opponents)
//   * Group stage: 8 groups of 4, single round-robin (BO3), top 2 advance
//   * Playoffs: 16-team single-elimination bracket (Ro16 → QF → SF → Final)

import { TEAMS } from "./teams.js";
import { autoVeto } from "./veto.js";

// ---- Format constants ----------------------------------------------------

export const GROUP_COUNT = 8;       // number of groups
export const GROUP_SIZE = 4;        // teams per group
export const ADVANCE_PER_GROUP = 2; // top N of each group advance
export const FIELD_SIZE = GROUP_COUNT * GROUP_SIZE;        // 32 teams total
export const BRACKET_SIZE = GROUP_COUNT * ADVANCE_PER_GROUP; // 16 playoff teams

// Playoff rounds. round index -> stage key.
export const STAGES = ["ro16", "quarter", "semi", "final"];
export const STAGE_LABELS = {
  group: "Group Stage",
  ro16: "Round of 16",
  quarter: "Quarterfinals",
  semi: "Semifinals",
  final: "Grand Final",
};

// Group letter for a group index (0 -> "A").
export function groupLetter(idx) {
  return String.fromCharCode(65 + idx);
}

// Round-robin pairings for a group of GROUP_SIZE teams (indices within group).
const ROUND_ROBIN_PAIRS = (() => {
  const pairs = [];
  for (let i = 0; i < GROUP_SIZE; i++) {
    for (let j = i + 1; j < GROUP_SIZE; j++) pairs.push([i, j]);
  }
  return pairs; // 6 matches for a group of 4
})();

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

function groupMatch(groupIdx, index, teamA, teamB) {
  return {
    id: `g${groupIdx}-m${index}`,
    groupIdx,
    index,
    stage: "group",
    teamA,
    teamB,
    veto: null,
    mapsPlayed: [],
    winnerId: null,
    status: "live", // group matches are all immediately playable
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

// generateTournament(selectedTeam) — main entry point.
export function generateTournament(selectedTeamId, rng = Math.random) {
  const selected = TEAMS.find((t) => t.id === selectedTeamId);
  if (!selected) throw new Error("Unknown team: " + selectedTeamId);

  // Selected team + (FIELD_SIZE - 1) random opponents, then shuffle the whole
  // field so group placement is balanced and unpredictable.
  const opponents = shuffle(
    TEAMS.filter((t) => t.id !== selectedTeamId),
    rng
  ).slice(0, FIELD_SIZE - 1);
  const field = shuffle([selected, ...opponents], rng);

  // Split the field into GROUP_COUNT groups of GROUP_SIZE and build each
  // group's round-robin schedule.
  const groups = [];
  for (let g = 0; g < GROUP_COUNT; g++) {
    const members = field.slice(g * GROUP_SIZE, g * GROUP_SIZE + GROUP_SIZE);
    const matches = ROUND_ROBIN_PAIRS.map(([i, j], k) =>
      groupMatch(g, k, members[i], members[j])
    );
    groups.push({
      idx: g,
      name: `Group ${groupLetter(g)}`,
      teamIds: members.map((t) => t.id),
      matches,
    });
  }

  const tournament = {
    selectedTeamId,
    teams: field,
    groups,
    rounds: buildEmptyRounds(BRACKET_SIZE), // empty until the group stage ends
    phase: "group", // group | playoff
    currentStage: "group",
    champion: null,
  };

  // Resolve every match that does not involve the user's team right away so
  // the user only ever has to play their own path. This also seeds and plays
  // out the playoffs automatically if the user's team never reaches them.
  resolveAiMatches(tournament, rng);
  return tournament;
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

// Resolve every playable match that does not involve the user's team. Handles
// the full lifecycle: group matches first, then (once the group stage ends and
// the bracket is seeded) the playoff matches, cascading winners forward.
export function resolveAiMatches(tournament, rng = Math.random) {
  let changed = true;
  let guard = 0;
  while (changed && guard < 200) {
    changed = false;
    guard++;

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
        seedPlayoffs(tournament);
        changed = true;
      }
    }

    if (tournament.phase === "playoff") {
      for (const round of tournament.rounds) {
        for (const m of round) {
          if (m.status === "finished" || !m.teamA || !m.teamB) continue;
          if (involvesUser(tournament, m)) continue;
          autoResolveMatch(m, rng);
          if (m.status === "finished") {
            advanceWinner(tournament, m);
            changed = true;
          }
        }
      }
    }
  }
  updateCurrentStage(tournament);
}

// ---- Winner propagation --------------------------------------------------

// Place a finished playoff match's winner into its next-round slot and unlock
// it. Group matches have no `round` and do not propagate here — they feed the
// bracket through seedPlayoffs() once the group stage is complete.
export function advanceWinner(tournament, match) {
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

// currentStage = "group" until the group stage ends, otherwise the earliest
// playoff round that still has an unfinished match.
export function updateCurrentStage(tournament) {
  if (tournament.phase === "group" && !groupStageComplete(tournament)) {
    tournament.currentStage = "group";
    return;
  }
  for (let r = 0; r < tournament.rounds.length; r++) {
    if (tournament.rounds[r].some((m) => m.status !== "finished")) {
      tournament.currentStage = STAGES[r];
      return;
    }
  }
  tournament.currentStage = "final";
}
