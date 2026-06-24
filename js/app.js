// app.js — Bootstrap, in-memory state, UI rendering and event handling.

import { TEAMS, mapIcon } from "./teams.js";
import {
  initDB,
  createChampionship,
  saveChampionship,
  listChampionships,
  loadChampionship,
  deleteChampionship,
} from "./db.js";
import {
  generateTournament,
  findMatch,
  teamById,
  isPlayable,
  recordMap,
  advanceWinner,
  resolveAiMatches,
  involvesUser,
  computeStandings,
  groupStageComplete,
  groupLetter,
  STAGES,
  STAGE_LABELS,
} from "./engine.js";
import { createVeto, currentAction, applyVeto, autoVetoOpponent } from "./veto.js";
import { migrateIndexedDBToFirestore } from "./migrate.js";
import { confirmDialog } from "./dialog.js";

// ---- State ---------------------------------------------------------------

let tournament = null;       // active in-memory Tournament snapshot
let championshipId = null;   // id of the active saved championship record
let championshipName = "";    // its display name
let championships = [];        // metadata list shown on the home screen
let view = { name: "home", matchId: null };
const app = () => document.getElementById("app");

async function save() {
  if (tournament && championshipId) {
    try {
      await saveChampionship(championshipId, tournament, championshipName);
    } catch (e) { console.error("save failed", e); }
  }
}

async function refreshChampionships() {
  try { championships = await listChampionships(); }
  catch (e) { console.error("list failed", e); championships = []; }
}

// Central mutate-then-persist-then-render helper.
async function update(mutator) {
  mutator(tournament);
  await save();
  render();
}

// ---- Small view helpers --------------------------------------------------

const COLORS = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];
function avatarColor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

function avatar(team, size = "h-10 w-10 text-xs") {
  if (!team) return `<div class="${size} rounded bg-slate-700/60 grid place-items-center text-slate-500 font-bold">?</div>`;
  return `<div class="${size} rounded grid place-items-center font-bold text-white shrink-0"
    style="background:${avatarColor(team.id)}">${esc(team.tag.slice(0, 4))}</div>`;
}

function isUserTeam(team) {
  return team && tournament && team.id === tournament.selectedTeamId;
}

// Which veto side ("A" or "B") the user's team is on in this match, or null if
// the match doesn't involve the user. Used to keep the user's bans/picks manual
// while the opponent's are auto-resolved.
function userVetoSide(match) {
  if (!match || !tournament) return null;
  if (match.teamA && match.teamA.id === tournament.selectedTeamId) return "A";
  if (match.teamB && match.teamB.id === tournament.selectedTeamId) return "B";
  return null;
}

// Starting-side badge: CT (blue) or T (amber).
function sideBadge(side) {
  if (!side) return "";
  const cls = side === "CT"
    ? "bg-sky-500/20 text-sky-300"
    : "bg-amber-500/20 text-amber-300";
  return `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide ${cls}">${side}</span>`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// CS2 map icon (from MurkyYT/cs2-map-icons). Falls back to nothing if unknown.
function mapIconImg(name, size = "h-5 w-5") {
  const src = mapIcon(name);
  if (!src) return "";
  return `<img src="${esc(src)}" alt="${esc(name)}" loading="lazy"
    class="${size} object-contain shrink-0" />`;
}

// ---- Render dispatcher ----------------------------------------------------

function render() {
  if (view.name === "name") return renderName();
  if (view.name === "select") return renderSelect();
  if (view.name === "bracket") return renderBracket();
  if (view.name === "match") return renderMatch();
  return renderHome();
}

function shell(inner, opts = {}) {
  const back = opts.back
    ? `<button data-action="${opts.back.action}"
        class="text-slate-400 hover:text-accent transition text-sm flex items-center gap-1">&larr; ${esc(opts.back.label)}</button>`
    : "";
  const reset = (tournament && championshipId)
    ? `<button data-action="reset" class="text-xs text-slate-500 hover:text-red-400 transition">Delete championship</button>`
    : "";
  app().innerHTML = `
    <div class="max-w-7xl mx-auto px-4 py-6">
      <header class="flex items-center justify-between mb-6 gap-3">
        <div class="flex items-center gap-3 min-w-0">
          ${back}
          <h1 class="text-lg sm:text-2xl font-black tracking-tight truncate">
            <span class="text-accent">CS2</span> Championship Organizer
          </h1>
        </div>
        ${reset}
      </header>
      ${inner}
    </div>`;
}

// ---- Home ----------------------------------------------------------------

function fmtDate(ts) {
  if (!ts) return "";
  try { return new Date(ts).toLocaleString(); } catch { return ""; }
}

// One-line status summary for a saved championship.
function summary(state) {
  if (!state) return "Empty";
  if (state.champion) return `Champion · ${state.champion.name}`;
  return STAGE_LABELS[state.currentStage] || "In progress";
}

function championshipRow(c) {
  return `
    <div class="flex items-center gap-3 bg-panel border border-slate-800 rounded-lg p-3 hover:border-accent/60 transition">
      <button data-action="resume" data-id="${esc(c.id)}" class="flex-1 text-left min-w-0">
        <div class="font-bold truncate">${esc(c.name)}</div>
        <div class="text-xs text-slate-500 truncate">${esc(summary(c.state))} · ${esc(fmtDate(c.updatedAt))}</div>
      </button>
      <button data-action="delete" data-id="${esc(c.id)}"
        class="text-xs text-slate-500 hover:text-red-400 transition shrink-0">Delete</button>
    </div>`;
}

function renderHome() {
  const list = championships.length
    ? championships.map(championshipRow).join("")
    : `<p class="text-slate-500 text-sm">No saved championships yet — create your first one.</p>`;

  shell(`
    <div class="max-w-2xl mx-auto space-y-8">
      <div class="text-center space-y-2 pt-4">
        <h2 class="text-4xl sm:text-6xl font-black">Build Your <span class="text-accent">Major</span></h2>
        <p class="text-slate-400 max-w-md mx-auto">Create a championship, pick your team, veto the maps and march to the
          Grand Final.</p>
      </div>
      <div class="text-center">
        <button data-action="new"
          class="px-6 py-3 rounded-lg bg-accent text-ink hover:brightness-110 transition font-bold">
          + New Championship</button>
      </div>
      <div class="space-y-2">
        <div class="text-xs uppercase tracking-wide text-slate-500">Saved championships</div>
        ${list}
      </div>
    </div>`);
}

// ---- Name a new championship ---------------------------------------------

function renderName() {
  const suggestion = `Championship ${championships.length + 1}`;
  shell(`
    <div class="max-w-md mx-auto space-y-4 pt-6">
      <div>
        <h2 class="text-2xl font-bold">Name your championship</h2>
        <p class="text-slate-400 text-sm">Give this tournament a name so you can find it later.</p>
      </div>
      <input data-name-input type="text" maxlength="60" placeholder="${esc(suggestion)}"
        class="w-full bg-slate-800 rounded-lg px-4 py-3 text-base outline-none focus:ring-2 focus:ring-accent" />
      <div class="flex gap-2">
        <button data-action="name-submit"
          class="px-6 py-3 rounded-lg bg-accent text-ink font-bold hover:brightness-110 transition">Continue</button>
      </div>
    </div>`,
    { back: { action: "goto-home", label: "Home" } });
  const input = document.querySelector("[data-name-input]");
  if (input) input.focus();
}

// ---- Team selection -------------------------------------------------------

function renderSelect() {
  const cards = TEAMS.map((t) => `
    <button data-action="select-team" data-team="${t.id}"
      class="group text-left bg-panel rounded-xl p-4 border border-slate-800 hover:border-accent
             hover:-translate-y-0.5 transition shadow">
      <div class="flex items-center gap-3 mb-2">
        ${avatar(t, "h-11 w-11 text-sm")}
        <div class="min-w-0">
          <div class="font-bold truncate group-hover:text-accent transition">${esc(t.name)}</div>
          <div class="text-xs text-slate-500">${esc(t.tag)}</div>
        </div>
      </div>
      <div class="text-[11px] text-slate-400 leading-relaxed truncate">${t.players.map(esc).join(" · ")}</div>
    </button>`).join("");

  shell(`
    <div class="mb-4">
      <h2 class="text-2xl font-bold">Choose your team</h2>
      <p class="text-slate-400 text-sm">The other 31 slots are drawn at random from the remaining ${TEAMS.length - 1} teams,
        then split into 8 groups of 4. Top 2 of each group reach the Round of 16.</p>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">${cards}</div>`,
    { back: { action: "goto-home", label: "Home" } });
}

// ---- Bracket --------------------------------------------------------------

function teamSlot(match, side) {
  const team = side === "A" ? match.teamA : match.teamB;
  const finished = match.status === "finished";
  const isWinner = finished && team && match.winnerId === team.id;
  const isLoser = finished && team && match.winnerId !== team.id;
  let cls = "";
  if (isWinner) cls = "bg-emerald-500/15 text-emerald-300";
  else if (isLoser) cls = "opacity-50 line-through";
  const ring = isUserTeam(team) ? "ring-1 ring-accent" : "";
  return `
    <div class="flex items-center gap-2 px-2 py-1 rounded ${cls} ${ring}">
      ${avatar(team, "h-6 w-6 text-[9px]")}
      <span class="text-xs truncate flex-1">${team ? esc(team.name) : "<span class='text-slate-600'>TBD</span>"}</span>
      ${isWinner ? '<span class="text-[10px]">✓</span>' : ""}
    </div>`;
}

function matchCard(match) {
  const finished = match.status === "finished";
  // The user only ever plays matches involving their own team; the rest are
  // auto-resolved and can be opened read-only to review the result.
  const userTurn = isPlayable(match) && involvesUser(tournament, match);
  const openable = userTurn || finished;
  const border = finished
    ? "border-slate-700"
    : userTurn ? "border-yellow-500/60" : "border-slate-800";
  const cursor = openable ? "cursor-pointer hover:border-accent" : "opacity-60";
  return `
    <div data-action="${openable ? "open-match" : ""}" data-match="${match.id}"
      class="bg-panel border ${border} ${cursor} rounded-lg p-1.5 w-44 transition">
      ${teamSlot(match, "A")}
      <div class="h-px bg-slate-800 my-0.5"></div>
      ${teamSlot(match, "B")}
      ${userTurn ? '<div class="text-[9px] text-yellow-500 text-center mt-0.5 uppercase tracking-wide">your match · click to play</div>' : ""}
    </div>`;
}

// One row of a group standings table.
function standingRow(stat, rank, complete) {
  const team = teamById(tournament, stat.teamId);
  const advancing = rank < 2; // top 2 qualify
  const mapDiff = stat.mapsWon - stat.mapsLost;
  const diffStr = mapDiff > 0 ? `+${mapDiff}` : `${mapDiff}`;
  const rankCls = advancing ? "text-emerald-400" : "text-slate-600";
  const rowCls = advancing ? "bg-emerald-500/5" : "";
  const ring = isUserTeam(team) ? "ring-1 ring-accent" : "";
  const qual = advancing && complete
    ? '<span class="text-[9px] font-bold text-emerald-400">Q</span>' : "";
  return `
    <div class="flex items-center gap-2 px-1.5 py-1 rounded ${rowCls} ${ring}">
      <span class="w-3 text-center text-xs font-bold ${rankCls}">${rank + 1}</span>
      ${avatar(team, "h-5 w-5 text-[8px]")}
      <span class="text-xs truncate flex-1">${esc(team.name)}</span>
      ${qual}
      <span class="text-[10px] font-mono text-slate-400 w-6 text-right">${stat.wins}-${stat.losses}</span>
      <span class="text-[10px] font-mono text-slate-500 w-7 text-right">${diffStr}</span>
    </div>`;
}

// Compact clickable pill for a single group (round-robin) match.
function groupMatchPill(match) {
  const finished = match.status === "finished";
  const userTurn = isPlayable(match) && involvesUser(tournament, match);
  const openable = userTurn || finished;
  let a = 0, b = 0;
  for (const m of match.mapsPlayed) {
    if (m.winnerId === match.teamA.id) a++; else b++;
  }
  const score = finished || a + b > 0
    ? `<span class="font-mono text-slate-400">${a}–${b}</span>`
    : `<span class="text-slate-600">vs</span>`;
  const border = userTurn ? "border-yellow-500/60" : "border-slate-800";
  const cursor = openable ? "cursor-pointer hover:border-accent" : "opacity-60";
  const aWon = finished && match.winnerId === match.teamA.id;
  const bWon = finished && match.winnerId === match.teamB.id;
  return `
    <div data-action="${openable ? "open-match" : ""}" data-match="${match.id}"
      class="flex items-center gap-1.5 text-[11px] px-1.5 py-1 rounded border ${border} ${cursor} transition">
      <span class="flex-1 text-right truncate ${aWon ? "text-emerald-300 font-semibold" : ""} ${isUserTeam(match.teamA) ? "!text-accent" : ""}">${esc(match.teamA.tag)}</span>
      ${score}
      <span class="flex-1 truncate ${bWon ? "text-emerald-300 font-semibold" : ""} ${isUserTeam(match.teamB) ? "!text-accent" : ""}">${esc(match.teamB.tag)}</span>
      ${userTurn ? '<span class="text-[8px] text-yellow-500 uppercase">play</span>' : ""}
    </div>`;
}

function groupCard(group) {
  const complete = group.matches.every((m) => m.status === "finished");
  const standings = computeStandings(tournament, group);
  const hasUser = group.teamIds.includes(tournament.selectedTeamId);
  const rows = standings.map((s, i) => standingRow(s, i, complete)).join("");
  const pills = group.matches.map(groupMatchPill).join("");
  return `
    <div class="bg-panel border ${hasUser ? "border-accent/50" : "border-slate-800"} rounded-xl p-3 space-y-2">
      <div class="flex items-center justify-between">
        <div class="font-bold text-sm">${esc(group.name)}</div>
        <div class="text-[10px] uppercase tracking-wide ${complete ? "text-emerald-400" : "text-slate-500"}">
          ${complete ? "Final" : "In progress"}</div>
      </div>
      <div class="space-y-0.5">${rows}</div>
      <div class="pt-1 border-t border-slate-800 space-y-1">${pills}</div>
    </div>`;
}

function renderBracket() {
  const champ = tournament.champion;
  const banner = champ
    ? `<div class="mb-6 rounded-xl p-5 text-center bg-gradient-to-r from-accent/20 to-emerald-500/20 border border-accent">
        <div class="text-xs uppercase tracking-widest text-accent">Champion</div>
        <div class="flex items-center justify-center gap-3 mt-2">
          ${avatar(champ, "h-12 w-12 text-base")}
          <span class="text-2xl font-black">${esc(champ.name)}</span>
        </div>
        ${isUserTeam(champ) ? '<div class="mt-1 text-emerald-300 font-semibold">🏆 Your team won it all!</div>' : ""}
      </div>`
    : "";

  const groupsDone = groupStageComplete(tournament);
  const groupsActive = tournament.currentStage === "group";

  // Group stage section: 8 group cards with live standings + match pills.
  const groupCards = tournament.groups.map(groupCard).join("");
  const groupsSection = `
    <section class="mb-8">
      <div class="flex items-center gap-3 mb-3">
        <h3 class="text-sm font-bold uppercase tracking-wide ${groupsActive ? "text-accent" : "text-slate-400"}">Group Stage</h3>
        <span class="text-xs text-slate-500">8 groups of 4 · top 2 advance</span>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">${groupCards}</div>
    </section>`;

  // Playoff bracket section (TBD slots until the group stage seeds it).
  const columns = tournament.rounds.map((round, r) => {
    const active = STAGES[r] === tournament.currentStage && !champ;
    const cards = round.map(matchCard).join("");
    return `
      <div class="flex flex-col min-w-[11rem]">
        <div class="text-center text-xs font-bold uppercase tracking-wide mb-3
          ${active ? "text-accent" : "text-slate-500"}">${STAGE_LABELS[STAGES[r]]}</div>
        <div class="flex flex-col gap-3 justify-around flex-1">${cards}</div>
      </div>`;
  }).join("");
  const playoffSection = `
    <section>
      <div class="flex items-center gap-3 mb-3">
        <h3 class="text-sm font-bold uppercase tracking-wide ${!groupsActive && !champ ? "text-accent" : "text-slate-400"}">Playoffs</h3>
        ${groupsDone ? "" : '<span class="text-xs text-slate-500">unlocks after the group stage</span>'}
      </div>
      <div class="overflow-x-auto pb-4 ${groupsDone ? "" : "opacity-50"}">
        <div class="flex gap-6 items-stretch min-w-max">${columns}</div>
      </div>
    </section>`;

  const tools = `
    <div class="flex flex-wrap gap-2 mb-4">
      <button data-action="download" class="px-3 py-1.5 text-sm rounded bg-slate-700 hover:bg-slate-600 transition">
        Download JSON</button>
    </div>`;

  shell(`
    ${banner}
    ${tools}
    ${groupsSection}
    ${playoffSection}`,
    { back: { action: "goto-home", label: "Home" } });
}

// ---- Match view -----------------------------------------------------------

function playersList(team) {
  if (!team) return "";
  return team.players.map((p) => `
    <li class="flex items-center gap-2 text-sm text-slate-300">
      <span class="h-1.5 w-1.5 rounded-full" style="background:${avatarColor(team.id)}"></span>${esc(p)}
    </li>`).join("");
}

function teamPanel(team, match) {
  const finished = match.status === "finished";
  const won = finished && team && match.winnerId === team.id;
  const lost = finished && team && match.winnerId !== team.id;
  const tag = won ? '<span class="text-emerald-400 text-xs font-bold">WINNER</span>'
    : lost ? '<span class="text-red-400 text-xs font-bold">ELIMINATED</span>' : "";
  return `
    <div class="bg-panel rounded-xl p-4 border ${won ? "border-emerald-500/60" : "border-slate-800"}
      ${isUserTeam(team) ? "ring-1 ring-accent" : ""}">
      <div class="flex items-center gap-3 mb-3">
        ${avatar(team, "h-12 w-12 text-sm")}
        <div class="min-w-0">
          <div class="font-bold truncate">${team ? esc(team.name) : "TBD"}</div>
          <div class="text-xs text-slate-500">${team ? esc(team.tag) : ""} ${isUserTeam(team) ? "· Your team" : ""}</div>
        </div>
      </div>
      ${tag}
      <ul class="space-y-1 mt-2">${playersList(team)}</ul>
    </div>`;
}

function vetoPanel(match) {
  const veto = match.veto;
  if (!veto) {
    return `
      <div class="text-center space-y-3 bg-panel rounded-xl p-4 border border-slate-800">
        <p class="text-slate-400 text-sm">No maps vetoed yet. You ban and pick manually —
          your opponent's choices are made at random.</p>
        <div class="flex justify-center">
          <button data-action="start-veto" data-match="${match.id}"
            class="px-4 py-2 rounded bg-accent text-ink font-semibold hover:brightness-110 transition text-sm">Start Map Veto</button>
        </div>
      </div>`;
  }

  const log = veto.log.map((e) => {
    const team = e.team === "A" ? match.teamA : e.team === "B" ? match.teamB : null;
    const label = e.type === "ban" ? "BAN" : e.type === "pick" ? "PICK" : "DECIDER";
    const color = e.type === "ban" ? "text-red-400" : e.type === "pick" ? "text-emerald-400" : "text-accent";
    return `<div class="flex items-center justify-between text-xs py-0.5">
      <span class="flex items-center gap-1.5"><span class="${color} font-bold">${label}</span>
        ${mapIconImg(e.map, "h-4 w-4")}${esc(e.map)}</span>
      <span class="text-slate-500">${team ? esc(team.tag) : "—"}</span></div>`;
  }).join("");

  let actionBox = "";
  if (!veto.complete) {
    // Opponent turns are auto-resolved before render, so the pending action is
    // always the user's own ban/pick.
    const action = currentAction(veto);
    const activeTeam = action.team === "A" ? match.teamA : match.teamB;
    const verb = action.type === "ban" ? "BAN" : "PICK";
    const verbColor = action.type === "ban" ? "text-red-400" : "text-emerald-400";
    const maps = veto.pool.map((m) => `
      <button data-action="veto-pick" data-match="${match.id}" data-map="${esc(m)}"
        class="flex items-center gap-1.5 px-3 py-2 rounded bg-slate-800 hover:bg-accent hover:text-ink transition text-sm font-medium">
        ${mapIconImg(m, "h-5 w-5")}${esc(m)}</button>`).join("");
    actionBox = `
      <div class="mt-3 p-3 rounded-lg bg-slate-900/60 border border-slate-800">
        <div class="text-sm mb-2"><span class="font-bold">${esc(activeTeam.name)}</span> to
          <span class="${verbColor} font-bold">${verb}</span>
          <span class="text-slate-500 text-xs">· your pick</span></div>
        <div class="flex flex-wrap gap-2">${maps}</div>
      </div>`;
  }

  return `
    <div class="bg-panel rounded-xl p-4 border border-slate-800">
      <div class="text-xs uppercase tracking-wide text-slate-500 mb-1">Map Veto · BO3</div>
      <div class="rounded-lg bg-slate-900/40 border border-slate-800 p-2">${log || '<span class="text-slate-600 text-xs">—</span>'}</div>
      ${actionBox}
    </div>`;
}

function mapsPanel(match) {
  if (!match.veto || !match.veto.complete) return "";
  const a = match.teamA, b = match.teamB;
  const playedCount = match.mapsPlayed.length;

  const rows = match.veto.picked.map((mapName, i) => {
    const played = match.mapsPlayed[i];
    const isNext = !played && i === playedCount && match.status !== "finished";
    const sides = (match.veto.sides && match.veto.sides[i]) || null;
    if (played) {
      const aWon = played.winnerId === a.id;
      return `
        <div class="flex items-center justify-between rounded bg-slate-900/60 border border-slate-800 px-3 py-2">
          <span class="flex items-center gap-2 text-sm font-medium">${mapIconImg(mapName, "h-6 w-6")}${esc(mapName)}</span>
          <span class="flex items-center gap-2 text-sm font-mono">
            ${sideBadge(played.sideA)}
            <span class="${aWon ? "text-emerald-400 font-bold" : "text-slate-400"}">${played.scoreA}</span>
            <span class="text-slate-600">:</span>
            <span class="${!aWon ? "text-emerald-400 font-bold" : "text-slate-400"}">${played.scoreB}</span>
            ${sideBadge(played.sideB)}
          </span>
        </div>`;
    }
    if (isNext) {
      return `
        <div data-maprow class="rounded bg-slate-900/60 border border-yellow-500/40 px-3 py-2 space-y-2">
          <div class="flex items-center justify-between">
            <span class="flex items-center gap-2 text-sm font-medium">${mapIconImg(mapName, "h-6 w-6")}${esc(mapName)}
              <span class="text-yellow-500 text-xs">· next map</span></span>
            ${sides ? `<span class="text-[10px] text-slate-500">${esc(a.tag)} ${sideBadge(sides.sideA)} · ${sideBadge(sides.sideB)} ${esc(b.tag)}</span>` : ""}
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <input type="number" min="0" max="30" value="13" data-score="A"
              class="w-16 bg-slate-800 rounded px-2 py-1 text-sm text-center" />
            <span class="text-slate-500 text-xs">${esc(a.tag)} : ${esc(b.tag)}</span>
            <input type="number" min="0" max="30" value="0" data-score="B"
              class="w-16 bg-slate-800 rounded px-2 py-1 text-sm text-center" />
            <button data-action="save-score" data-match="${match.id}" data-map="${esc(mapName)}"
              class="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 transition text-sm">Enter Score</button>
          </div>
        </div>`;
    }
    return `
      <div class="flex items-center justify-between rounded bg-slate-900/30 border border-slate-800/60 px-3 py-2 opacity-50">
        <span class="flex items-center gap-2 text-sm">${mapIconImg(mapName, "h-6 w-6")}${esc(mapName)}</span>
        ${sides
          ? `<span class="flex items-center gap-1 text-[10px]">${esc(a.tag)} ${sideBadge(sides.sideA)} · ${sideBadge(sides.sideB)} ${esc(b.tag)}</span>`
          : '<span class="text-xs text-slate-600">locked</span>'}
      </div>`;
  }).join("");

  return `
    <div class="bg-panel rounded-xl p-4 border border-slate-800 space-y-2">
      <div class="text-xs uppercase tracking-wide text-slate-500">Maps</div>
      ${rows}
    </div>`;
}

function renderMatch() {
  const match = findMatch(tournament, view.matchId);
  if (!match) { view = { name: "bracket" }; return render(); }

  let a = 0, b = 0;
  for (const m of match.mapsPlayed) {
    if (m.winnerId === match.teamA.id) a++; else b++;
  }
  const finished = match.status === "finished";
  const winner = finished ? teamById(tournament, match.winnerId) : null;

  const controls = finished
    ? `<div class="rounded-lg bg-emerald-500/10 border border-emerald-500/40 p-3 text-center">
         <div class="text-emerald-300 font-bold">${esc(winner.name)} wins the series ${a}–${b}</div>
         <button data-action="goto-bracket" class="mt-2 px-4 py-2 rounded bg-accent text-ink font-semibold text-sm">Back to Bracket</button>
       </div>`
    : `<div class="rounded-lg bg-slate-800/60 border border-slate-700 p-3 text-center text-sm text-slate-400">
         Enter each map's score above to decide the series (first to 2 maps).
       </div>`;

  const stageLabel = typeof match.groupIdx === "number"
    ? `Group ${groupLetter(match.groupIdx)} · Group Stage`
    : STAGE_LABELS[match.stage];

  shell(`
    <div class="mb-4 text-center">
      <div class="text-xs uppercase tracking-widest text-accent">${esc(stageLabel)}</div>
      <div class="text-3xl font-black mt-1 font-mono">${a} <span class="text-slate-600">:</span> ${b}</div>
    </div>
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div class="order-2 lg:order-1">${teamPanel(match.teamA, match)}</div>
      <div class="order-1 lg:order-2 space-y-4">
        ${vetoPanel(match)}
        ${mapsPanel(match)}
        ${controls}
      </div>
      <div class="order-3">${teamPanel(match.teamB, match)}</div>
    </div>`,
    { back: { action: "goto-bracket", label: "Bracket" } });
}

// ---- Actions / events -----------------------------------------------------

async function onClick(e) {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  if (!action) return;
  const matchId = el.dataset.match;

  switch (action) {
    case "new":
      view = { name: "name" };
      return render();

    case "name-submit": {
      const input = document.querySelector("[data-name-input]");
      const name = (input && input.value.trim()) || `Championship ${championships.length + 1}`;
      view = { name: "select", pendingName: name };
      return render();
    }

    case "goto-home":
      tournament = null;
      championshipId = null;
      championshipName = "";
      await refreshChampionships();
      view = { name: "home" };
      return render();

    case "goto-bracket":
      view = { name: "bracket" };
      return render();

    case "select-team": {
      const state = generateTournament(el.dataset.team);
      const name = (view.pendingName || "").trim() || `Championship ${championships.length + 1}`;
      try {
        const rec = await createChampionship(name, state);
        championshipId = rec.id;
        championshipName = rec.name;
      } catch (e) {
        console.error("create failed", e);
        championshipId = null;
        championshipName = name;
      }
      tournament = state;
      view = { name: "bracket" };
      return render();
    }

    case "resume": {
      try {
        const rec = await loadChampionship(el.dataset.id);
        if (!rec) { await refreshChampionships(); return render(); }
        championshipId = rec.id;
        championshipName = rec.name;
        tournament = rec.state;
        view = { name: "bracket" };
      } catch (e) { console.error("resume failed", e); }
      return render();
    }

    case "delete": {
      const ok = await confirmDialog({
        title: "Delete championship?",
        message: "This permanently removes the saved championship. This cannot be undone.",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      try { await deleteChampionship(el.dataset.id); } catch (e) { console.error(e); }
      if (el.dataset.id === championshipId) {
        tournament = null;
        championshipId = null;
        championshipName = "";
      }
      await refreshChampionships();
      view = { name: "home" };
      return render();
    }

    case "open-match":
      view = { name: "match", matchId };
      return render();

    case "start-veto":
      return update((t) => {
        const m = findMatch(t, matchId);
        if (!m.veto) m.veto = createVeto();
        if (m.status === "pending") m.status = "live";
        // Auto-resolve any leading opponent turns so the user lands on theirs.
        autoVetoOpponent(m.veto, userVetoSide(m));
      });

    case "veto-pick":
      return update((t) => {
        const m = findMatch(t, matchId);
        if (m.veto && !m.veto.complete && currentAction(m.veto)?.team === userVetoSide(m)) {
          applyVeto(m.veto, el.dataset.map);
          // Then let the opponent randomly resolve up to the user's next turn.
          autoVetoOpponent(m.veto, userVetoSide(m));
        }
      });

    case "save-score": {
      const row = el.closest("[data-maprow]") || document;
      const inA = row.querySelector('input[data-score="A"]');
      const inB = row.querySelector('input[data-score="B"]');
      const scoreA = Math.max(0, parseInt(inA.value, 10) || 0);
      const scoreB = Math.max(0, parseInt(inB.value, 10) || 0);
      if (scoreA === scoreB) { flash(inA); flash(inB); return; }
      return update((t) => {
        const m = findMatch(t, matchId);
        const done = recordMap(m, el.dataset.map, scoreA, scoreB);
        if (done) {
          advanceWinner(t, m);
          // Resolve any matches that no longer involve the user (e.g. once the
          // user is eliminated the rest of the bracket plays out automatically).
          resolveAiMatches(t);
        }
      });
    }

    case "download":
      return downloadJSON();

    case "reset": {
      const ok = await confirmDialog({
        title: "Delete championship?",
        message: "This permanently removes the saved championship. This cannot be undone.",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      try { if (championshipId) await deleteChampionship(championshipId); } catch (e2) { console.error(e2); }
      tournament = null;
      championshipId = null;
      championshipName = "";
      await refreshChampionships();
      view = { name: "home" };
      return render();
    }
  }
}

function flash(input) {
  if (!input) return;
  input.classList.add("ring-2", "ring-red-500");
  setTimeout(() => input.classList.remove("ring-2", "ring-red-500"), 600);
}

function downloadJSON() {
  const blob = new Blob([JSON.stringify(tournament, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "cs2_tournament.json";
  a.click();
  URL.revokeObjectURL(url);
}

// ---- Bootstrap ------------------------------------------------------------

async function main() {
  try {
    await initDB();
    // One-time copy of any championships saved by the old IndexedDB build.
    await migrateIndexedDBToFirestore();
    await refreshChampionships();
  } catch (err) {
    console.error("DB init failed, continuing in-memory:", err);
  }
  view = { name: "home" };
  app().addEventListener("click", onClick);
  // Submit the championship name with Enter.
  app().addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("[data-name-input]")) {
      e.preventDefault();
      const btn = document.querySelector('[data-action="name-submit"]');
      if (btn) onClick({ target: btn });
    }
  });
  render();
}

main();
