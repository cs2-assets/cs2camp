// app.js — Bootstrap, in-memory state, UI rendering and event handling.

import { TEAMS, mapIcon, teamLogo } from "./teams.js";
import {
  initDB,
  createChampionship,
  saveChampionship,
  listChampionships,
  loadChampionship,
  deleteChampionship,
  getCsMatches,
  getReadyCsMatches,
  markCsMatchImported,
  markCsMatchIgnored,
  getCsPlayerMatchesByUser,
  getProfile,
  saveProfile,
  saveMapOrder,
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
  deAllMatches,
  STAGES,
  STAGE_LABELS,
  FORMATS,
  DEFAULT_FORMAT,
} from "./engine.js";
import { createVeto, currentAction, applyVeto, autoVetoOpponent, userOptions, chooseSide, needsUserSide, PICK_COUNT, BAN_COUNT } from "./veto.js";
import { confirmDialog, alertDialog } from "./dialog.js";
import { withLoading, setSaving } from "./loading.js";
import { getMapOrder, setMapOrder, clearMapOrder, reconcileMapOrder } from "./prefs.js";
import { onAuth, signInWithGoogle, signOutUser } from "./auth.js";
import { grantChampionReward } from "./rewards.js";
import {
  createCrew,
  listMyCrews,
  listMyInvites,
  inviteEmail,
  revokeInvite,
  acceptInvite,
  removeMember,
  leaveCrew,
  renameCrew,
  deleteCrewWithChampionships,
  syncCrewMembership,
} from "./crews.js";
import Sortable from "sortablejs";

// ---- State ---------------------------------------------------------------

let user = null;             // signed-in Firebase user (null when logged out)
let userNickname = "";       // the user's CS nickname (from their profile doc)
let userMapOrder = [];       // the user's saved map preference order (from profile)
let profileLoaded = false;   // whether the profile fetch has completed this session
let onboardingDismissed = false; // user skipped the nickname onboarding this session
let crews = [];              // Teams the user belongs to
let invites = [];            // pending Team invites (by email)
let activeCrewId = null;     // currently selected Team
let editingTeamName = false; // inline rename of the active Team in progress
let tournament = null;       // active in-memory Tournament snapshot
let championshipId = null;   // id of the active saved championship record
let championshipName = "";    // its display name
let championships = [];        // metadata list shown on the home screen
const app = () => document.getElementById("app");

// ---- Multi-page routing --------------------------------------------------
// Each destination is a separate HTML file. The page name comes from
// <body data-page="…"> (set by the build), and everything else needed to
// rebuild this page's state is read from the URL query string. Cross-page
// navigation is a real page load via go(); only in-page interactions re-render.
const PAGE = (document.body && document.body.dataset.page) || "home";
const params = new URLSearchParams(location.search);
const urlMatchId = params.get("match") || null;        // match.html / match-info.html
const urlMapIdx = params.has("map") ? parseInt(params.get("map"), 10) : null; // match-info.html
const urlScope = params.get("scope") === "global" ? "global" : "championship"; // dashboard.html

// Home-page create wizard sub-state (home → name → select → new-crew). Only the
// home page uses this; the other pages are addressed by their own URL.
let homeView = "home";
let pendingName = "";
let pendingFormat = DEFAULT_FORMAT;   // chosen championship format for the new championship

function go(url) { location.assign(url); }
const urlHome = () => "index.html";
const urlBracket = (id) => `bracket.html?id=${encodeURIComponent(id)}`;
const urlMatch = (id, mId) => `match.html?id=${encodeURIComponent(id)}&match=${encodeURIComponent(mId)}`;
const urlMatchInfo = (id, mId, idx) => `match-info.html?id=${encodeURIComponent(id)}&match=${encodeURIComponent(mId)}&map=${idx}`;
const urlDashboard = (scope, id) => `dashboard.html?scope=${scope}${id ? `&id=${encodeURIComponent(id)}` : ""}`;

// Cache of CS extractor match data keyed by map UUID. Populated lazily when a
// match screen or dashboard is opened; absence means "not fetched / not yet
// uploaded by the plugin". Cleared when switching away from a championship.
let csMatchCache = {};
// CS results the plugin has flagged ready to import (status == "READY"). The
// user picks the one matching the map they just played; importing flips it to
// "IMPORTED" so it drops out of this list. Loaded on the match screen.
let readyCsMatches = [];
let csGlobalStats = null;   // cached per-player records for the global dashboard
let dashboardLoading = false;
let dashboardError = null;  // last dashboard fetch error message, or null
let expandedPlayer = null;  // dashboard: player key whose insight panel is open
let compareKeys = [];       // dashboard: up to 2 player keys selected to compare
let dashboardMetric = "rating"; // dashboard: which metric the time-series chart plots

const ACTIVE_CREW_KEY = "cs2.activeCrewId";
function activeCrew() {
  return crews.find((c) => c.id === activeCrewId) || null;
}

// When the active championship is won by the user's own CS team, grant the
// signed-in user a reward in Habit Farm (see rewards.js). Best-effort and
// once-per-session per championship (the write itself is idempotent anyway).
const grantedRewards = new Set();
async function maybeGrantChampionReward() {
  if (!tournament || !championshipId) return;
  const champ = tournament.champion;
  if (!champ || champ.id !== tournament.selectedTeamId) return;
  if (grantedRewards.has(championshipId)) return;
  grantedRewards.add(championshipId);
  try {
    await grantChampionReward(championshipId, champ.name);
  } catch (e) {
    console.error("Habit Farm reward grant failed", e);
    grantedRewards.delete(championshipId);   // allow a retry next time
  }
}

async function save({ silent = false } = {}) {
  if (tournament && championshipId) {
    if (!silent) setSaving(true);
    try {
      await saveChampionship(championshipId, tournament, championshipName);
    } catch (e) { console.error("save failed", e); }
    finally { if (!silent) setSaving(false); }
  }
}

// Load every championship the user can access (one array-contains query), then
// keep only the active Team's for display. `champRows()` reads `championships`.
let allChampionships = [];
async function refreshChampionships() {
  try { allChampionships = user ? await listChampionships(user.uid) : []; }
  catch (e) { console.error("list failed", e); allChampionships = []; }
  championships = activeCrewId
    ? allChampionships.filter((c) => c.crewId === activeCrewId)
    : [];
}

// Reload the user's Teams and pending invites; reconcile the active selection.
async function refreshCrews() {
  try { crews = user ? await listMyCrews() : []; }
  catch (e) { console.error("crews list failed", e); crews = []; }
  try { invites = user ? await listMyInvites() : []; }
  catch (e) { console.error("invites list failed", e); invites = []; }
  const saved = (() => { try { return localStorage.getItem(ACTIVE_CREW_KEY); } catch { return null; } })();
  if (saved && crews.some((c) => c.id === saved)) activeCrewId = saved;
  else if (!crews.some((c) => c.id === activeCrewId)) activeCrewId = crews.length ? crews[0].id : null;
  try { if (activeCrewId) localStorage.setItem(ACTIVE_CREW_KEY, activeCrewId); } catch { /* ignore */ }
}

// Central mutate-then-persist-then-render helper. Pass `loadingMessage` to show
// a blocking spinner overlay while the change is processed and persisted (the
// background "Saving…" pill is suppressed in that case to avoid double feedback).
async function update(mutator, loadingMessage) {
  const run = async () => {
    mutator(tournament);
    await save({ silent: !!loadingMessage });
    render();
  };
  return loadingMessage ? withLoading(loadingMessage, run) : run();
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
  const logo = teamLogo(team.id);
  // Generated tag avatar is the base; the real logo (if any) overlays it and is
  // removed on load error, revealing the tag behind it.
  const overlay = logo
    ? `<img src="${esc(logo)}" alt="${esc(team.name)}" loading="lazy"
        onerror="this.remove()"
        class="absolute inset-0 h-full w-full object-contain bg-slate-900/80 p-0.5" />`
    : "";
  return `<div class="${size} rounded grid place-items-center font-bold text-white shrink-0 relative overflow-hidden"
    style="background:${avatarColor(team.id)}">${esc(team.tag.slice(0, 4))}${overlay}</div>`;
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

// Copy text to the clipboard, falling back to a hidden textarea + execCommand
// when the async Clipboard API is unavailable (insecure context / old browser).
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through to legacy path */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

// ---- CS extractor integration --------------------------------------------

// Every match in the tournament across all formats (groups, brackets, Swiss
// rounds, double-elim winners/losers/grand-final), flat.
function allMatches(t) {
  const out = [];
  if (!t) return out;
  for (const g of t.groups || []) for (const m of g.matches || []) out.push(m);
  for (const round of t.rounds || []) for (const m of round || []) out.push(m);
  if (t.swiss) for (const round of t.swiss.rounds || []) for (const m of round) out.push(m);
  if (t.de) out.push(...deAllMatches(t));
  return out;
}

// All generated map UUIDs across the whole tournament (one per picked map).
function allMapUuids(t) {
  const ids = [];
  for (const m of allMatches(t)) {
    if (m.veto && m.veto.complete && Array.isArray(m.veto.mapIds)) {
      for (const id of m.veto.mapIds) if (id) ids.push(id);
    }
  }
  return ids;
}

// The signed-in user's record in a CS match's players[], or null.
function csMe(cs) {
  const uid = user && user.uid;
  if (!uid || !Array.isArray(cs.players)) return null;
  return cs.players.find((p) => p.userId === uid) || null;
}

// The tracked team's (my team's) score/enemy score for a CS match, resolved
// independently of the CT/T side swap. Prefers the signed-in user's own
// per-player perspective (correct even if tracked players split teams), then
// the match-doc's myTeam summary. Returns { mine, theirs } or null.
function csMyScore(cs) {
  const me = csMe(cs);
  if (me && me.teamScore != null && me.enemyScore != null) {
    return { mine: Number(me.teamScore) || 0, theirs: Number(me.enemyScore) || 0 };
  }
  if (cs.myTeam && cs.myTeam.score != null) {
    return { mine: Number(cs.myTeam.score) || 0, theirs: Number((cs.enemyTeam && cs.enemyTeam.score)) || 0 };
  }
  return null;
}

// My team's starting side ("CT" | "T") for a CS match, or null.
function csMyStartSide(cs) {
  const me = csMe(cs);
  if (me && me.startSide) return String(me.startSide).toUpperCase();
  if (cs.myTeam && cs.myTeam.startSide) return String(cs.myTeam.startSide).toUpperCase();
  return null;
}

// Map a CS match's score onto our Team A / Team B for map `mapIdx` of `match`.
// Returns { scoreA, scoreB } or null if it can't be mapped.
//
// The plugin now resolves "my team" vs "enemy team" scores for us (robust to
// the halftime side swap), so we assign my-team's score to the user's bracket
// team. Older match docs predate those fields, so we fall back to mapping the
// raw score.ct/score.t by the user's CT/T team label, then by starting side.
function mapCsScore(match, mapIdx, cs) {
  if (!cs) return null;
  const userBracketSide = userVetoSide(match);           // "A" | "B" | null

  // Preferred: plugin-resolved my-team / enemy-team scores.
  const resolved = csMyScore(cs);
  if (userBracketSide && resolved) {
    return userBracketSide === "A"
      ? { scoreA: resolved.mine, scoreB: resolved.theirs }
      : { scoreA: resolved.theirs, scoreB: resolved.mine };
  }

  if (!cs.score) return null;
  const ct = Number(cs.score.ct) || 0;
  const t = Number(cs.score.t) || 0;

  // Legacy fallback: derive my-team's side from the per-player CT/T label.
  const me = csMe(cs);
  const userTeamLabel = me && me.team ? String(me.team).toUpperCase() : null;
  if (userBracketSide && userTeamLabel) {
    const mine = userTeamLabel === "CT" ? ct : t;
    const theirs = userTeamLabel === "CT" ? t : ct;
    return userBracketSide === "A" ? { scoreA: mine, scoreB: theirs } : { scoreA: theirs, scoreB: mine };
  }
  // Last resort: assume score is keyed by Team A's starting side.
  const sides = match.veto && match.veto.sides && match.veto.sides[mapIdx];
  if (sides) return sides.sideA === "CT" ? { scoreA: ct, scoreB: t } : { scoreA: t, scoreB: ct };
  return { scoreA: ct, scoreB: t };
}

// CS2 map icon (from MurkyYT/cs2-map-icons). Falls back to nothing if unknown.
function mapIconImg(name, size = "h-5 w-5") {
  const src = mapIcon(name);
  if (!src) return "";
  // Hide the image if the asset is missing (e.g. a map with no local icon yet).
  return `<img src="${esc(src)}" alt="${esc(name)}" loading="lazy" draggable="false"
    onerror="this.style.display='none'"
    class="${size} object-contain shrink-0" />`;
}

// ---- Render dispatcher ----------------------------------------------------

function render() {
  if (!user) return renderSignIn();
  // First-run onboarding: ask for the CS nickname before anything else (once the
  // profile has loaded and the user hasn't set or skipped it).
  if (profileLoaded && !userNickname && !onboardingDismissed) return renderOnboarding();
  switch (PAGE) {
    case "bracket": return renderBracket();
    case "match": return renderMatch();
    case "info": return renderMatchInfo();
    case "dashboard": return renderDashboard();
    default:
      // Home page hosts the create wizard as in-page steps.
      if (homeView === "new-crew") return renderNewCrew();
      if (homeView === "name") return renderName();
      if (homeView === "select") return renderSelect();
      return renderHome();
  }
}

// Signed-in user chip + sign-out, shown in the header. Empty when logged out.
function userChip() {
  if (!user) return "";
  const photo = user.photoURL
    ? `<img src="${esc(user.photoURL)}" referrerpolicy="no-referrer" alt="" class="h-7 w-7 rounded-full shrink-0" />`
    : `<div class="h-7 w-7 rounded-full bg-slate-700 grid place-items-center text-xs font-bold shrink-0">${esc((user.displayName || user.email || "?").slice(0, 1).toUpperCase())}</div>`;
  return `
    <div class="flex items-center gap-2 min-w-0">
      ${photo}
      <span class="text-sm text-slate-300 hidden sm:inline truncate max-w-[10rem]">${esc(user.displayName || user.email || "Account")}</span>
      <button data-action="sign-out" class="text-xs text-slate-500 hover:text-red-400 transition shrink-0">Sign out</button>
    </div>`;
}

function shell(inner, opts = {}) {
  // Back link: an href crosses pages (real load); an action runs in-page.
  const backCls = "text-slate-400 hover:text-accent transition text-sm flex items-center gap-1";
  const back = opts.back
    ? (opts.back.href
        ? `<a href="${esc(opts.back.href)}" class="${backCls}">&larr; ${esc(opts.back.label)}</a>`
        : `<button data-action="${opts.back.action}" class="${backCls}">&larr; ${esc(opts.back.label)}</button>`)
    : "";
  const reset = (tournament && championshipId)
    ? `<button data-action="reset" class="text-xs text-slate-500 hover:text-red-400 transition">Delete championship</button>`
    : "";
  app().innerHTML = `
    <div class="max-w-7xl mx-auto px-4 py-6">
      <header class="flex items-center justify-between mb-6 gap-3 bg-panel border border-slate-800 rounded-xl px-4 py-3 shadow-lg">
        <div class="flex items-center gap-3 min-w-0">
          ${back}
          <h1 class="text-lg sm:text-2xl font-black tracking-tight truncate">
            <span class="text-accent">CS2</span> Championship Organizer
          </h1>
        </div>
        <div class="flex items-center gap-3 shrink-0">
          ${reset}
          ${userChip()}
        </div>
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

// Map pool used for the BO3 veto, shown on the home screen as a drag-and-drop
// ranked list (powered by SortableJS, see initMapSort): the order is the user's
// team preference and drives the order of their veto pick/ban options.
function mapPoolSection() {
  const order = currentMapOrder();
  const chips = order.map((m, i) => `
    <div data-map-chip="${esc(m)}"
      class="group flex items-center gap-2 bg-panel border border-slate-800 rounded-lg px-3 py-2 hover:border-accent/60 transition">
      <span data-rank class="text-xs font-mono text-slate-500 w-5 text-center shrink-0">${i + 1}</span>
      ${mapIconImg(m, "h-6 w-6")}
      <span class="text-sm font-medium truncate flex-1">${esc(m)}</span>
      <span data-drag-handle class="text-slate-600 group-hover:text-slate-400 select-none shrink-0 cursor-grab active:cursor-grabbing px-1" aria-label="Drag to reorder" title="Drag to reorder">⠿</span>
    </div>`).join("");
  return `
    <div class="space-y-2">
      <div class="flex items-center justify-between gap-2">
        <div class="text-xs uppercase tracking-wide text-slate-500">Map Pool · ${order.length} maps · your preference</div>
        <button data-action="reset-map-order" class="text-xs text-slate-500 hover:text-accent transition">Reset order</button>
      </div>
      <p class="text-xs text-slate-600">Drag the handle to rank maps by preference — most preferred first. Used to order your veto picks and bans.</p>
      <div data-map-pool class="flex flex-col gap-2">${chips}</div>
    </div>`;
}

// (Re)initialise SortableJS on the map preference list after each home render.
let mapSortable = null;
function initMapSort() {
  const list = document.querySelector("[data-map-pool]");
  if (!list) return;
  if (mapSortable) { mapSortable.destroy(); mapSortable = null; }
  mapSortable = Sortable.create(list, {
    animation: 150,
    handle: "[data-drag-handle]",
    ghostClass: "opacity-40",
    onEnd: async () => {
      const order = Array.from(list.querySelectorAll("[data-map-chip]")).map((c) => c.dataset.mapChip);
      userMapOrder = order;
      setMapOrder(order);   // localStorage cache for instant first paint
      // Renumber ranks in place (no full re-render needed).
      list.querySelectorAll("[data-map-chip] [data-rank]").forEach((el, i) => { el.textContent = i + 1; });
      // Persist to the user's profile in Firestore.
      if (user) {
        setSaving(true);
        try { await saveMapOrder(user.uid, order); }
        catch (e) { console.error("save map order failed", e); }
        finally { setSaving(false); }
      }
    },
  });
}

// Full-screen background used on the signed-out and home screens.
function bgLayer() {
  return `
    <div class="fixed inset-0 -z-10 bg-cover bg-center"
      style="background-image:linear-gradient(to bottom, rgba(11,17,32,0.55), rgba(11,17,32,0.8)), url('img/bg/bg2.jpg')"></div>
    <div class="fixed bottom-2 right-3 -z-10 text-[10px] text-slate-400/70 select-none">
      Counter-Strike © Valve</div>`;
}

// Signed-out screen: the only thing available before authenticating.
function renderSignIn() {
  app().innerHTML = `
    ${bgLayer()}
    <div class="min-h-screen grid place-items-center px-4">
      <div class="bg-ink border border-slate-800 rounded-2xl p-8 shadow-2xl text-center space-y-5 max-w-sm w-full">
        <h1 class="text-2xl font-black tracking-tight">
          <span class="text-accent">CS2</span> Championship Organizer</h1>
        <p class="text-sm text-slate-400">Sign in to create teams, run championships, and collaborate with your friends.</p>
        <button data-action="sign-in"
          class="w-full px-4 py-3 rounded-lg bg-white text-slate-900 font-semibold hover:brightness-95 transition flex items-center justify-center gap-2">
          <svg class="h-5 w-5" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.9 2.4 30.4 0 24 0 14.6 0 6.4 5.4 2.5 13.3l7.9 6.1C12.2 13.7 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.5 3-2.2 5.5-4.7 7.2l7.3 5.7c4.3-3.9 6.8-9.8 6.8-17.4z"/><path fill="#FBBC05" d="M10.4 28.6c-.5-1.5-.8-3-.8-4.6s.3-3.1.8-4.6l-7.9-6.1C.9 16.5 0 20.1 0 24s.9 7.5 2.5 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.7c-2 1.4-4.6 2.3-8.6 2.3-6.4 0-11.8-4.2-13.6-9.9l-7.9 6.1C6.4 42.6 14.6 48 24 48z"/></svg>
          Sign in with Google</button>
      </div>
    </div>`;
}

// A copyable line showing the signed-in user's Firebase User ID — paste it into
// the CS extractor plugin so your matches are tagged to this account.
function uidLine() {
  if (!user) return "";
  return `
    <div class="flex items-center gap-2 text-xs">
      <span class="uppercase tracking-wide text-slate-500 shrink-0">User ID</span>
      <span class="font-mono text-slate-400 truncate" title="${esc(user.uid)}">${esc(user.uid)}</span>
      <button data-action="copy-uid" data-id="${esc(user.uid)}"
        class="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition shrink-0"
        title="Copy your User ID">Copy</button>
    </div>`;
}

// First-run onboarding: capture the user's CS nickname (and surface their User
// ID to copy into the plugin). Reached from render() until a nickname is set.
function renderOnboarding() {
  app().innerHTML = `
    ${bgLayer()}
    <div class="min-h-screen grid place-items-center px-4">
      <div class="bg-ink border border-slate-800 rounded-2xl p-8 shadow-2xl space-y-5 max-w-sm w-full">
        <div class="text-center space-y-1">
          <h1 class="text-2xl font-black tracking-tight">Welcome${user && user.displayName ? `, ${esc(user.displayName.split(" ")[0])}` : ""}!</h1>
          <p class="text-sm text-slate-400">What's your in-game CS nickname? We use it to match your match stats to you.</p>
        </div>
        <input data-nick-input type="text" maxlength="40" value="${esc(userNickname)}"
          class="w-full bg-slate-800 rounded-lg px-4 py-3 text-base outline-none focus:ring-2 focus:ring-accent" />
        <button data-action="save-nickname"
          class="w-full px-4 py-3 rounded-lg bg-accent text-ink font-bold hover:brightness-110 transition">Save &amp; continue</button>
        <div class="pt-3 border-t border-slate-800 space-y-2">
          <p class="text-[11px] text-slate-500">Configure your CS server plugin with this ID so uploaded matches link to your account:</p>
          ${uidLine()}
        </div>
        <div class="text-center">
          <button data-action="skip-onboarding" class="text-xs text-slate-500 hover:text-slate-300 transition">Skip for now</button>
        </div>
      </div>
    </div>`;
  const input = document.querySelector("[data-nick-input]");
  if (input) input.focus();
}

// Shown on a deep-linked page (bracket/match/dashboard) when its championship
// can't be loaded — bad id, deleted, or no access. Offers a way home.
function renderMissingChampionship() {
  shell(`
    <div class="max-w-md mx-auto bg-panel rounded-xl p-6 border border-slate-800 text-center space-y-3">
      <div class="text-slate-300 font-semibold">Championship not found</div>
      <p class="text-sm text-slate-500">It may have been deleted, or you don't have access to it.</p>
      <a href="${esc(urlHome())}" class="inline-block px-4 py-2 rounded-lg bg-accent text-ink font-semibold text-sm">Go home</a>
    </div>`, { back: { href: urlHome(), label: "Home" } });
}

// Inline "name a new team" screen (mirrors renderName).
function renderNewCrew() {
  shell(`
    ${bgLayer()}
    <div class="max-w-md mx-auto space-y-4 pt-6">
      <div class="bg-ink border border-slate-800 rounded-xl p-5 shadow-xl space-y-4">
        <div>
          <div class="text-xs uppercase tracking-wide text-slate-500">New team</div>
          <p class="text-sm text-slate-400">Name your team. You can invite friends after creating it.</p>
        </div>
        <input data-crew-input type="text" placeholder="e.g. The Squad" maxlength="40"
          class="w-full bg-slate-800 rounded-lg px-3 py-2 text-sm" />
        <div class="flex justify-end gap-2">
          <button data-action="goto-home" class="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 transition text-sm">Cancel</button>
          <button data-action="crew-submit" class="px-4 py-2 rounded-lg bg-accent text-ink font-bold text-sm">Create team</button>
        </div>
      </div>
    </div>`, { back: { action: "goto-home", label: "Home" } });
  const input = document.querySelector("[data-crew-input]");
  if (input) input.focus();
}

function shortUid(u) {
  return u ? `Member ${esc(String(u).slice(0, 5))}` : "Member";
}

// Team selector pills + "new team".
function teamSwitcher() {
  const pills = crews.map((c) => `
    <button data-action="select-crew" data-crew="${esc(c.id)}"
      class="px-3 py-1.5 rounded-full text-sm font-medium transition ${c.id === activeCrewId ? "bg-accent text-ink" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}">
      ${esc(c.name)}</button>`).join("");
  return `
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-xs uppercase tracking-wide text-slate-500 mr-1">Teams</span>
      ${pills || '<span class="text-sm text-slate-500">No teams yet</span>'}
      <button data-action="new-crew"
        class="px-3 py-1.5 rounded-full text-sm bg-slate-800 text-accent hover:bg-slate-700 transition">+ New Team</button>
    </div>`;
}

// Pending email invites to other teams.
function invitesBanner() {
  if (!invites.length) return "";
  return invites.map((c) => `
    <div class="flex items-center justify-between gap-3 bg-amber-500/10 border border-amber-500/40 rounded-lg px-3 py-2">
      <span class="text-sm">You're invited to <span class="font-bold">${esc(c.name)}</span></span>
      <button data-action="accept-invite" data-crew="${esc(c.id)}"
        class="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 transition text-sm font-semibold">Accept</button>
    </div>`).join("");
}

// Members + invite management for the active team.
function teamManagePanel() {
  const crew = activeCrew();
  if (!crew) return "";
  const isOwner = user && crew.ownerUid === user.uid;
  const members = crew.memberUids.map((m) => {
    const isMe = user && m === user.uid;
    const ownerTag = m === crew.ownerUid ? ' <span class="text-slate-500">· owner</span>' : "";
    const removeBtn = (isOwner && m !== crew.ownerUid)
      ? `<button data-action="remove-member" data-crew="${esc(crew.id)}" data-uid="${esc(m)}" class="text-xs text-slate-500 hover:text-red-400 transition">Remove</button>`
      : "";
    return `<div class="flex items-center justify-between text-sm py-0.5">
      <span class="truncate">${isMe ? "You" : shortUid(m)}${ownerTag}</span>${removeBtn}</div>`;
  }).join("");
  const invited = crew.invitedEmails.map((e) => `
    <div class="flex items-center justify-between text-sm py-0.5">
      <span class="truncate text-slate-400">${esc(e)} <span class="text-[10px] text-amber-400">pending</span></span>
      ${isOwner ? `<button data-action="revoke-invite" data-crew="${esc(crew.id)}" data-email="${esc(e)}" class="text-xs text-slate-500 hover:text-red-400 transition">Revoke</button>` : ""}
    </div>`).join("");
  const inviteForm = isOwner ? `
    <div class="flex gap-2 pt-2 border-t border-slate-800">
      <input data-invite-input data-crew="${esc(crew.id)}" type="email" placeholder="friend@email.com"
        class="flex-1 bg-slate-800 rounded px-2 py-1 text-sm" />
      <button data-action="invite-email" data-crew="${esc(crew.id)}"
        class="px-3 py-1 rounded bg-accent text-ink text-sm font-semibold">Invite</button>
    </div>` : "";
  const manageBtn = isOwner
    ? `<button data-action="delete-crew" data-crew="${esc(crew.id)}" class="text-xs text-red-400 transition">Delete team</button>`
    : `<button data-action="leave-crew" data-crew="${esc(crew.id)}" class="text-xs text-red-400 transition">Leave team</button>`;
  const nameBlock = (isOwner && editingTeamName)
    ? `<div class="flex items-center gap-2 min-w-0">
        <input data-team-name-input data-crew="${esc(crew.id)}" type="text" maxlength="40" value="${esc(crew.name)}"
          class="bg-slate-800 rounded px-2 py-1 text-sm min-w-0" />
        <button data-action="save-crew-name" data-crew="${esc(crew.id)}" class="text-xs text-accent hover:brightness-110 shrink-0">Save</button>
        <button data-action="cancel-rename" class="text-xs text-slate-300 shrink-0">Cancel</button>
      </div>`
    : `<div class="flex items-center gap-2 min-w-0">
        <div class="text-xs uppercase tracking-wide text-slate-500 truncate">${esc(crew.name)} · members</div>
        ${isOwner ? `<button data-action="rename-crew" class="text-xs text-accent shrink-0">Rename</button>` : ""}
      </div>`;
  return `
    <div class="space-y-2">
      <div class="flex items-center justify-between gap-2">
        ${nameBlock}
        ${manageBtn}
      </div>
      <div>${members}</div>
      ${invited ? `<div class="pt-1">${invited}</div>` : ""}
      ${inviteForm}
    </div>`;
}

// Account card on the home page: edit the CS nickname and copy the User ID.
function accountPanel() {
  return `
    <div class="bg-ink/90 border border-slate-800 rounded-xl p-4 shadow-xl space-y-3">
      <div class="text-xs uppercase tracking-wide text-slate-500">Your CS profile</div>
      <div class="flex flex-col sm:flex-row sm:items-end gap-2">
        <label class="flex-1 min-w-0">
          <span class="block text-[11px] text-slate-500 mb-1">CS nickname</span>
          <input data-nick-input type="text" maxlength="40" value="${esc(userNickname)}"
            class="w-full bg-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent" />
        </label>
        <button data-action="save-nickname"
          class="px-4 py-2 rounded-lg bg-accent text-ink font-bold text-sm hover:brightness-110 transition shrink-0">Save</button>
      </div>
      ${uidLine()}
    </div>`;
}

function renderHome() {
  const crew = activeCrew();
  const list = championships.length
    ? championships.map(championshipRow).join("")
    : `<p class="text-slate-500 text-sm">${crew ? "No championships in this team yet — create your first one." : "Create or select a team to start."}</p>`;

  const createBtn = crew
    ? `<button data-action="new"
         class="px-6 py-3 rounded-lg bg-accent text-ink hover:brightness-110 transition font-bold shadow-lg">+ Create</button>`
    : `<button disabled title="Create or select a team first"
         class="px-6 py-3 rounded-lg bg-slate-700 text-slate-400 font-bold cursor-not-allowed">+ Create</button>`;

  shell(`
    ${bgLayer()}
    <div class="max-w-5xl mx-auto space-y-6">
      <div class="bg-ink/90 border border-slate-800 rounded-xl p-4 shadow-xl space-y-3">
        ${teamSwitcher()}
        ${invitesBanner()}
      </div>
      ${accountPanel()}
      <div class="text-center flex items-center justify-center gap-3">
        ${createBtn}
        <button data-action="dashboard" data-scope="global"
          class="px-6 py-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 transition font-bold shadow-lg">📊 My Stats</button>
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <div class="space-y-6">
          <div class="bg-ink border border-slate-800 rounded-xl p-4 shadow-xl space-y-3">
            <div class="text-xs uppercase tracking-wide text-slate-500">${crew ? esc(crew.name) + " · championships" : "Championships"}</div>
            ${list}
          </div>
          ${crew ? `<div class="bg-ink border border-slate-800 rounded-xl p-4 shadow-xl">${teamManagePanel()}</div>` : ""}
        </div>
        ${crew ? `<div class="bg-ink border border-slate-800 rounded-xl p-4 shadow-xl">
          ${mapPoolSection()}
        </div>` : ""}
      </div>
    </div>`);
  if (crew) initMapSort();
}

// ---- Name a new championship ---------------------------------------------

function renderName() {
  const suggestion = `Championship ${championships.length + 1}`;
  const formatCards = Object.values(FORMATS).map((f) => {
    const active = pendingFormat === f.key;
    return `
      <button data-action="set-format" data-format="${f.key}"
        class="text-left rounded-xl p-3 border transition ${active ? "border-accent bg-accent/10" : "border-slate-800 bg-panel hover:border-slate-600"}">
        <div class="flex items-center justify-between gap-2">
          <span class="font-bold text-sm ${active ? "text-accent" : ""}">${esc(f.label)}</span>
          <span class="text-[10px] text-slate-500 shrink-0">${f.field} teams</span>
        </div>
        <div class="text-[11px] text-slate-400 leading-snug mt-1">${esc(f.blurb)}</div>
      </button>`;
  }).join("");

  shell(`
    <div class="max-w-md mx-auto space-y-4 pt-6">
      <div>
        <h2 class="text-2xl font-bold">Name your championship</h2>
        <p class="text-slate-400 text-sm">Give this tournament a name so you can find it later.</p>
      </div>
      <input data-name-input type="text" maxlength="60" placeholder="${esc(suggestion)}" value="${esc(pendingName)}"
        class="w-full bg-slate-800 rounded-lg px-4 py-3 text-base outline-none focus:ring-2 focus:ring-accent" />
      <div class="space-y-2">
        <div class="text-xs uppercase tracking-wide text-slate-500">Format</div>
        <div class="grid grid-cols-1 gap-2">${formatCards}</div>
      </div>
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
  const fmt = FORMATS[pendingFormat] || FORMATS[DEFAULT_FORMAT];
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
      <p class="text-slate-400 text-sm">
        <span class="text-accent font-semibold">${esc(fmt.label)}</span> · the other ${fmt.field - 1}
        slots are drawn at random from the remaining ${TEAMS.length - 1} teams. ${esc(fmt.blurb)}</p>
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
function standingRow(stat, rank, complete, advanceCount = 2) {
  const team = teamById(tournament, stat.teamId);
  const advancing = rank < advanceCount;
  const mapDiff = stat.mapsWon - stat.mapsLost;
  const diffStr = mapDiff > 0 ? `+${mapDiff}` : `${mapDiff}`;
  const rankCls = advancing ? "text-emerald-400" : "text-slate-600";
  const rowCls = advancing ? "bg-emerald-500/5" : "";
  const ring = isUserTeam(team) ? "ring-1 ring-accent" : "";
  // League (advanceCount 1): the leader is the champion; groups: top N qualify.
  const qual = advancing && complete
    ? (advanceCount === 1 ? '<span class="text-[10px]">👑</span>' : '<span class="text-[9px] font-bold text-emerald-400">Q</span>')
    : "";
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
  const advanceCount = tournament.format === "league" ? 1 : 2;
  const rows = standings.map((s, i) => standingRow(s, i, complete, advanceCount)).join("");
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

// Render an array of bracket rounds as labeled columns of match cards.
function bracketCols(rounds, labelOf) {
  return rounds.map((round, r) => `
    <div class="flex flex-col min-w-[11rem]">
      <div class="text-center text-xs font-bold uppercase tracking-wide mb-3 text-slate-500">${esc(labelOf(r))}</div>
      <div class="flex flex-col gap-3 justify-around flex-1">${round.map(matchCard).join("")}</div>
    </div>`).join("");
}

// Compact Swiss records table: every team by record, with qualified/eliminated.
function swissRecordsTable() {
  const sw = tournament.swiss;
  const ids = tournament.teams.map((t) => t.id)
    .sort((a, b) => (sw.records[b].w - sw.records[a].w) || (sw.records[a].l - sw.records[b].l));
  const rows = ids.map((id) => {
    const r = sw.records[id];
    const team = teamById(tournament, id);
    const q = r.w >= 3, e = r.l >= 3;
    const badge = q ? '<span class="text-[9px] font-bold text-emerald-400">Q</span>'
      : e ? '<span class="text-[9px] font-bold text-red-400">OUT</span>' : "";
    const rowCls = q ? "bg-emerald-500/5" : e ? "opacity-50" : "";
    const ring = isUserTeam(team) ? "ring-1 ring-accent" : "";
    return `
      <div class="flex items-center gap-2 px-1.5 py-1 rounded ${rowCls} ${ring}">
        ${avatar(team, "h-5 w-5 text-[8px]")}
        <span class="text-xs truncate flex-1">${esc(team.name)}</span>
        ${badge}
        <span class="text-[11px] font-mono ${r.w > r.l ? "text-emerald-300" : r.l > r.w ? "text-red-300" : "text-slate-400"}">${r.w}-${r.l}</span>
      </div>`;
  }).join("");
  return `
    <div class="bg-panel border border-slate-800 rounded-xl p-3 space-y-0.5">
      <div class="text-xs uppercase tracking-wide text-slate-500 mb-1">Records · 3 wins qualify · 3 losses out</div>
      ${rows}
    </div>`;
}

function renderBracket() {
  if (!tournament) return renderMissingChampionship();
  const champ = tournament.champion;
  const banner = champ
    ? `<div class="mb-6 rounded-xl p-5 text-center bg-gradient-to-r from-accent/20 to-emerald-500/20 border border-accent">
        <div class="text-xs uppercase tracking-widest text-accent">Champion</div>
        <div class="flex items-center justify-center gap-3 mt-2">
          ${avatar(champ, "h-12 w-12 text-base")}
          <span class="text-2xl font-black">${esc(champ.name)}</span>
        </div>
        ${isUserTeam(champ) ? `<div class="mt-1 text-emerald-300 font-semibold">🏆 Your team won it all!</div>
          <div class="mt-1 text-xs text-slate-300">🎁 A reward is waiting in your Habit Farm store (reload Habit Farm to see it).</div>` : ""}
      </div>`
    : "";

  const format = tournament.format || "groups";
  const stages = (tournament.stages && tournament.stages.length) ? tournament.stages : STAGES;
  const groupsDone = groupStageComplete(tournament);
  const groupsActive = tournament.currentStage === "group";

  // --- Group / league section ---
  const groupCards = tournament.groups.map(groupCard).join("");
  const groupsSection = format === "league"
    ? `<section class="mb-8 max-w-xl mx-auto">
        <div class="flex items-center gap-3 mb-3">
          <h3 class="text-sm font-bold uppercase tracking-wide text-accent">League Table</h3>
          <span class="text-xs text-slate-500">round robin · top of the table wins</span>
        </div>
        ${groupCards}
      </section>`
    : `<section class="mb-8">
        <div class="flex items-center gap-3 mb-3">
          <h3 class="text-sm font-bold uppercase tracking-wide ${groupsActive ? "text-accent" : "text-slate-400"}">Group Stage</h3>
          <span class="text-xs text-slate-500">8 groups of 4 · top 2 advance</span>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">${groupCards}</div>
      </section>`;

  // --- Playoff bracket section ---
  const columns = tournament.rounds.map((round, r) => {
    const active = stages[r] === tournament.currentStage && !champ;
    const cards = round.map(matchCard).join("");
    return `
      <div class="flex flex-col min-w-[11rem]">
        <div class="text-center text-xs font-bold uppercase tracking-wide mb-3
          ${active ? "text-accent" : "text-slate-500"}">${STAGE_LABELS[stages[r]] || ""}</div>
        <div class="flex flex-col gap-3 justify-around flex-1">${cards}</div>
      </div>`;
  }).join("");
  const bracketLocked = format === "groups" && !groupsDone;
  const showPlayoffHeader = format === "groups" || (format === "swiss" && tournament.rounds.length);
  const playoffSection = `
    <section>
      ${showPlayoffHeader ? `
        <div class="flex items-center gap-3 mb-3">
          <h3 class="text-sm font-bold uppercase tracking-wide ${!groupsActive && !champ ? "text-accent" : "text-slate-400"}">Playoffs</h3>
          ${format === "groups" && !groupsDone ? '<span class="text-xs text-slate-500">unlocks after the group stage</span>' : ""}
        </div>` : ""}
      <div class="overflow-x-auto pb-4 ${bracketLocked ? "opacity-50" : ""}">
        <div class="flex gap-6 items-stretch min-w-max">${columns}</div>
      </div>
    </section>`;

  // --- Swiss section (records + each round's matches) ---
  let swissSection = "";
  if (format === "swiss") {
    const swissCols = bracketCols(tournament.swiss.rounds, (r) => `Round ${r + 1}`);
    swissSection = `
      <section class="mb-8">
        <div class="flex items-center gap-3 mb-3">
          <h3 class="text-sm font-bold uppercase tracking-wide ${tournament.phase === "swiss" ? "text-accent" : "text-slate-400"}">Swiss Stage</h3>
          <span class="text-xs text-slate-500">pairs by record · 3 wins qualify, 3 losses out</span>
        </div>
        <div class="grid grid-cols-1 lg:grid-cols-[18rem_1fr] gap-4">
          ${swissRecordsTable()}
          <div class="overflow-x-auto pb-2"><div class="flex gap-6 items-stretch min-w-max">${swissCols}</div></div>
        </div>
      </section>`;
  }

  // --- Double-elimination section (winners + losers brackets + grand final) ---
  let doubleSection = "";
  if (format === "double") {
    const de = tournament.de;
    const wbCols = bracketCols(de.wb, (r) => ["Round 1", "Semifinals", "Final"][r] || "");
    const lbCols = bracketCols(de.lb, (r) => ["Round 1", "Round 2", "Round 3", "Final"][r] || "");
    const wrap = (cols) => `<div class="overflow-x-auto pb-2"><div class="flex gap-6 items-stretch min-w-max">${cols}</div></div>`;
    doubleSection = `
      <section class="space-y-5">
        <div>
          <h3 class="text-sm font-bold uppercase tracking-wide text-emerald-400 mb-3">Winners Bracket</h3>
          ${wrap(wbCols)}
        </div>
        <div>
          <h3 class="text-sm font-bold uppercase tracking-wide text-amber-400 mb-3">Losers Bracket</h3>
          ${wrap(lbCols)}
        </div>
        <div>
          <h3 class="text-sm font-bold uppercase tracking-wide text-accent mb-3">Grand Final</h3>
          <div class="flex">${matchCard(de.gf)}</div>
        </div>
      </section>`;
  }

  // Compose sections per format.
  const body =
    format === "single" ? playoffSection
    : format === "league" ? groupsSection
    : format === "swiss" ? `${swissSection}${tournament.rounds.length ? playoffSection : ""}`
    : format === "double" ? doubleSection
    : `${groupsSection}${playoffSection}`;

  shell(`
    ${banner}
    <div class="flex items-center justify-between mb-3">
      <span class="text-xs text-slate-500">${esc((FORMATS[format] || {}).label || "")}</span>
      <button data-action="dashboard" data-scope="championship"
        class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 transition text-sm font-semibold">📊 Player Stats</button>
    </div>
    ${body}`,
    { back: { href: urlHome(), label: "Home" } });
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
        <p class="text-slate-400 text-sm">No maps vetoed yet. You pick ${PICK_COUNT} and ban ${BAN_COUNT}
          maps — your opponent does the same at random, then the 3 maps with the most picks
          and fewest bans are played.</p>
        <div class="flex justify-center">
          <button data-action="start-veto" data-match="${match.id}"
            class="px-4 py-2 rounded bg-accent text-ink font-semibold hover:brightness-110 transition text-sm">Start Map Veto</button>
        </div>
      </div>`;
  }

  const log = veto.log.map((e) => {
    const team = e.team === "A" ? match.teamA : e.team === "B" ? match.teamB : null;
    const label = e.type === "ban" ? "BAN" : e.type === "pick" ? "PICK" : "PLAY";
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
    const ballot = veto.ballots[action.team];
    const done = action.type === "ban" ? ballot.bans.length : ballot.picks.length;
    const total = action.type === "ban" ? BAN_COUNT : PICK_COUNT;
    // Present the options in the user's saved preference order.
    const pref = currentMapOrder();
    const maps = userOptions(veto)
      .slice()
      .sort((x, y) => pref.indexOf(x) - pref.indexOf(y))
      .map((m) => `
      <button data-action="veto-pick" data-match="${match.id}" data-map="${esc(m)}"
        class="flex items-center gap-1.5 px-3 py-2 rounded bg-slate-800 hover:bg-accent hover:text-ink transition text-sm font-medium">
        ${mapIconImg(m, "h-5 w-5")}${esc(m)}</button>`).join("");
    actionBox = `
      <div class="mt-3 p-3 rounded-lg bg-slate-900/60 border border-slate-800">
        <div class="text-sm mb-2"><span class="font-bold">${esc(activeTeam.name)}</span> to
          <span class="${verbColor} font-bold">${verb}</span>
          <span class="text-slate-500 text-xs">· ${done + 1} of ${total} · your pick</span></div>
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

// The picker of ready-to-import CS results, shown on the map currently awaiting
// a score. The plugin no longer keys uploads to a pre-generated ID, so the user
// matches the right upload to the map they just played. Each candidate previews
// how it would be recorded (Team A : Team B from the user's perspective) plus
// enough metadata to tell them apart; results whose map matches this one float
// to the top and are flagged. Importing flips the doc's status to IMPORTED.
function csCandidatesBox(match, i, mapName) {
  if (!readyCsMatches.length) return "";
  const a = match.teamA, b = match.teamB;
  const sameMap = (cs) => cs.map && mapName && String(cs.map).toLowerCase() === String(mapName).toLowerCase();
  const ordered = [...readyCsMatches].sort((x, y) => (sameMap(y) ? 1 : 0) - (sameMap(x) ? 1 : 0));

  const rows = ordered.map((cs) => {
    const mapped = mapCsScore(match, i, cs);
    const me = csMe(cs);
    const score = mapped
      ? `${esc(a.tag)} <span class="font-mono font-bold">${mapped.scoreA}:${mapped.scoreB}</span> ${esc(b.tag)}`
      : `<span class="font-mono font-bold">${csNum(cs.score?.ct)}:${csNum(cs.score?.t)}</span> <span class="text-slate-500">CT:T</span>`;
    const meta = [
      fmtCsDateShort(cs.endedAtUtc),
      `${fmtDuration(cs.durationSeconds)} min`,
      cs.serverHostname ? esc(cs.serverHostname) : "",
      me ? `you ${csNum(me.kills)}-${csNum(me.deaths)}-${csNum(me.assists)}` : "",
    ].filter(Boolean).join(" · ");
    const match_ = sameMap(cs);
    return `
      <div class="flex items-center justify-between gap-2 rounded bg-slate-900/70 border ${match_ ? "border-accent/40" : "border-slate-800"} px-2.5 py-1.5">
        <div class="min-w-0">
          <div class="flex items-center gap-1.5 text-xs font-medium">
            ${mapIconImg(cs.map || mapName, "h-4 w-4")}<span class="truncate">${esc(cs.map || "Unknown map")}</span>
            ${match_ ? '<span class="text-[9px] uppercase tracking-wide text-accent shrink-0">matches map</span>' : ""}
          </div>
          <div class="text-[10px] text-slate-500">${score}${meta ? ` · ${meta}` : ""}</div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button data-action="import-result" data-match="${match.id}" data-mapidx="${i}" data-csid="${esc(cs.id)}"
            class="px-3 py-1 rounded bg-accent text-ink font-bold text-[11px] hover:brightness-110 transition">Import</button>
          <button data-action="delete-candidate" data-csid="${esc(cs.id)}" title="Delete this upload"
            class="px-2 py-1 rounded text-[11px] text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition">Delete</button>
        </div>
      </div>`;
  }).join("");

  return `
    <div class="rounded-md bg-accent/5 border border-accent/30 px-3 py-2 space-y-1.5">
      <div class="text-[11px] text-accent">📥 Import a CS result for this map — pick the upload that matches what you played:</div>
      ${rows}
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
    const uuid = match.veto.mapIds && match.veto.mapIds[i];
    const hasCs = uuid && csMatchCache[uuid];
    if (played) {
      const aWon = played.winnerId === a.id;
      const details = hasCs
        ? `<button data-action="match-info" data-match="${match.id}" data-mapidx="${i}"
            class="px-1.5 py-0.5 rounded bg-accent/20 text-accent hover:bg-accent/30 transition text-[10px] font-semibold shrink-0">Details</button>`
        : "";
      return `
        <div class="rounded bg-slate-900/60 border border-slate-800 px-3 py-2 space-y-1">
          <div class="flex items-center justify-between">
            <span class="flex items-center gap-2 text-sm font-medium">${mapIconImg(mapName, "h-6 w-6")}${esc(mapName)}</span>
            <span class="flex items-center gap-2 text-sm font-mono">
              ${sideBadge(played.sideA)}
              <span class="${aWon ? "text-emerald-400 font-bold" : "text-slate-400"}">${played.scoreA}</span>
              <span class="text-slate-600">:</span>
              <span class="${!aWon ? "text-emerald-400 font-bold" : "text-slate-400"}">${played.scoreB}</span>
              ${sideBadge(played.sideB)}
            </span>
          </div>
          ${details ? `<div class="flex items-center justify-end">${details}</div>` : ""}
        </div>`;
    }
    if (isNext) {
      // The user's team chooses its starting side on maps it didn't pick.
      const pickSide = needsUserSide(match.veto, i);
      const body = pickSide
        ? `<div class="space-y-2">
            <div class="text-[11px] text-yellow-400">Your team didn't pick this map — choose your starting side:</div>
            <div class="flex gap-2">
              <button data-action="choose-side" data-match="${match.id}" data-mapidx="${i}" data-side="CT"
                class="px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 transition text-sm font-bold">Start CT</button>
              <button data-action="choose-side" data-match="${match.id}" data-mapidx="${i}" data-side="T"
                class="px-3 py-1 rounded bg-amber-600 hover:bg-amber-500 transition text-sm font-bold">Start T</button>
            </div>
          </div>`
        : `<div class="flex flex-wrap items-center gap-2">
            <input type="number" min="0" max="30" value="0" data-score="A"
              class="w-16 bg-slate-800 rounded px-2 py-1 text-sm text-center" />
            <span class="text-slate-500 text-xs">${esc(a.tag)} : ${esc(b.tag)}</span>
            <input type="number" min="0" max="30" value="0" data-score="B"
              class="w-16 bg-slate-800 rounded px-2 py-1 text-sm text-center" />
            <button data-action="save-score" data-match="${match.id}" data-map="${esc(mapName)}"
              class="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 transition text-sm">Enter Score</button>
          </div>`;
      // Let the user pick which uploaded CS result corresponds to this map.
      const importBox = csCandidatesBox(match, i, mapName);
      return `
        <div data-maprow class="rounded bg-slate-900/60 border border-yellow-500/40 px-3 py-2 space-y-2">
          <div class="flex items-center justify-between">
            <span class="flex items-center gap-2 text-sm font-medium">${mapIconImg(mapName, "h-6 w-6")}${esc(mapName)}
              <span class="text-yellow-500 text-xs">· next map</span></span>
            ${sides ? `<span class="text-[10px] text-slate-500">${esc(a.tag)} ${sideBadge(sides.sideA)} · ${sideBadge(sides.sideB)} ${esc(b.tag)}</span>` : ""}
          </div>
          ${importBox}
          ${body}
        </div>`;
    }
    return `
      <div class="rounded bg-slate-900/30 border border-slate-800/60 px-3 py-2 opacity-50">
        <div class="flex items-center justify-between">
          <span class="flex items-center gap-2 text-sm">${mapIconImg(mapName, "h-6 w-6")}${esc(mapName)}</span>
          ${sides
            ? `<span class="flex items-center gap-1 text-[10px]">${esc(a.tag)} ${sideBadge(sides.sideA)} · ${sideBadge(sides.sideB)} ${esc(b.tag)}</span>`
            : '<span class="text-xs text-slate-600">locked</span>'}
        </div>
      </div>`;
  }).join("");

  return `
    <div class="bg-panel rounded-xl p-4 border border-slate-800 space-y-2">
      <div class="text-xs uppercase tracking-wide text-slate-500">Maps</div>
      ${rows}
    </div>`;
}

function renderMatch() {
  if (!tournament) return renderMissingChampionship();
  const match = findMatch(tournament, urlMatchId);
  if (!match) { go(urlBracket(championshipId)); return; }

  let a = 0, b = 0;
  for (const m of match.mapsPlayed) {
    if (m.winnerId === match.teamA.id) a++; else b++;
  }
  const finished = match.status === "finished";
  const winner = finished ? teamById(tournament, match.winnerId) : null;

  const controls = finished
    ? `<div class="rounded-lg bg-emerald-500/10 border border-emerald-500/40 p-3 text-center">
         <div class="text-emerald-300 font-bold">${esc(winner.name)} wins the series ${a}–${b}</div>
         <a href="${esc(urlBracket(championshipId))}" class="inline-block mt-2 px-4 py-2 rounded bg-accent text-ink font-semibold text-sm">Back to Bracket</a>
       </div>`
    : `<div class="rounded-lg bg-slate-800/60 border border-slate-700 p-3 text-center text-sm text-slate-400">
         Enter each map's score above to decide the series (first to 2 maps).
       </div>`;

  const stageLabel = match.stageLabel
    ? match.stageLabel
    : typeof match.groupIdx === "number"
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
    </div>
    ${seriesCsPanel(match)}`,
    { back: { href: urlBracket(championshipId), label: "Bracket" } });
}

// ---- CS match info & player dashboards ------------------------------------

const csNum = (v) => Number(v) || 0;

// Approximate HLTV Rating 2.0 from box-score stats. Uses the widely-cited
// public regression: KAST (as a percent), per-round kill/death/assist rates, an
// impact term, and ADR. A balanced player averages ~1.00; ~1.15+ is excellent.
function csRating({ kills, deaths, assists, rounds, adr, kast }) {
  const rp = rounds || 1;
  const kpr = kills / rp, dpr = deaths / rp, apr = assists / rp;
  const impact = 2.13 * kpr + 0.42 * apr - 0.41;
  const r = 0.0073 * kast + 0.3591 * kpr - 0.5329 * dpr + 0.2372 * impact + 0.0032 * adr + 0.1587;
  return Math.max(0, r);
}

// Normalize a player record (from a match's players[] OR a player_match doc)
// into the flat shape the scoreboard and aggregation use. `p.map` (depot name)
// is present on player_match docs and injected for a match's players[].
function csPlayerRow(p) {
  const adv = p.advanced || {};
  const rounds = csNum(adv.roundsPlayed) || csNum(p.roundsPlayed) || csNum(p.totalRounds);
  const row = {
    key: p.userId || p.nickname || "?",
    nickname: p.nickname || p.userId || "Unknown",
    team: (p.team || "").toUpperCase(),
    map: p.map || "",
    kills: csNum(p.kills),
    deaths: csNum(p.deaths),
    assists: csNum(p.assists),
    hsKills: csNum(p.headshotKills),
    mvps: csNum(p.mvps),
    score: csNum(p.score),
    rounds,
    kastRounds: csNum(adv.kastRounds),
    adr: csNum(adv.adr),
    kast: csNum(adv.kast),
    hsPct: csNum(adv.headshotPercent),
    // Insight extras.
    openingKills: csNum(adv.openingKills),
    openingDeaths: csNum(adv.openingDeaths),
    clutchesWon: csNum(adv.clutchesWon),
    clutchAttempts: csNum(adv.clutchAttempts),
    utilityDamage: csNum(adv.utilityDamage) || csNum(p.utilityDamage),
    weaponKills: adv.weaponKills || {},
    multiKills: adv.multiKills || {},
  };
  row.rating = csRating(row);
  return row;
}

// Aggregate many per-match player rows into one row per player, recomputing
// rate stats (ADR/KAST/HS%/rating) precisely from the underlying totals and
// rolling up the insight breakdowns (per-map, weapons, opening/clutch/multi).
function aggregatePlayers(rows) {
  const byKey = new Map();
  for (const r of rows) {
    let g = byKey.get(r.key);
    if (!g) {
      g = { key: r.key, nickname: r.nickname, matches: 0, kills: 0, deaths: 0, assists: 0, hsKills: 0, mvps: 0,
            rounds: 0, adrSum: 0, kastRounds: 0, openingKills: 0, openingDeaths: 0, clutchesWon: 0, clutchAttempts: 0,
            utilityDamage: 0, multi: { k2: 0, k3: 0, k4: 0, k5: 0 }, weapons: {}, perMap: new Map() };
      byKey.set(r.key, g);
    }
    if (r.nickname) g.nickname = r.nickname;
    g.matches += 1;
    g.kills += r.kills; g.deaths += r.deaths; g.assists += r.assists;
    g.hsKills += r.hsKills; g.mvps += r.mvps; g.rounds += r.rounds;
    g.adrSum += r.adr * r.rounds;      // round-weighted so the average is exact
    g.kastRounds += r.kastRounds;
    g.openingKills += r.openingKills; g.openingDeaths += r.openingDeaths;
    g.clutchesWon += r.clutchesWon; g.clutchAttempts += r.clutchAttempts;
    g.utilityDamage += r.utilityDamage;
    for (const k of ["k2", "k3", "k4", "k5"]) g.multi[k] += csNum(r.multiKills[k]);
    for (const [w, n] of Object.entries(r.weaponKills || {})) g.weapons[w] = (g.weapons[w] || 0) + csNum(n);
    if (r.map) {
      const pm = g.perMap.get(r.map) || { map: r.map, kills: 0, deaths: 0, rounds: 0, adrSum: 0 };
      pm.kills += r.kills; pm.deaths += r.deaths; pm.rounds += r.rounds; pm.adrSum += r.adr * r.rounds;
      g.perMap.set(r.map, pm);
    }
  }
  return [...byKey.values()].map((g) => {
    const adr = g.rounds ? g.adrSum / g.rounds : 0;
    const kast = g.rounds ? (g.kastRounds / g.rounds) * 100 : 0;
    return {
      ...g,
      kd: g.deaths ? g.kills / g.deaths : g.kills,
      adr, kast,
      hsPct: g.kills ? (g.hsKills / g.kills) * 100 : 0,
      rating: csRating({ kills: g.kills, deaths: g.deaths, assists: g.assists, rounds: g.rounds, adr, kast }),
      perMap: [...g.perMap.values()]
        .map((pm) => ({ ...pm, kd: pm.deaths ? pm.kills / pm.deaths : pm.kills, adr: pm.rounds ? pm.adrSum / pm.rounds : 0 }))
        .sort((x, y) => y.rounds - x.rounds),
    };
  }).sort((a, b) => (b.rating - a.rating) || (b.kd - a.kd));
}


function fmtDuration(secs) {
  const s = csNum(secs);
  if (!s) return "—";
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

// Firestore Timestamp | millis | {seconds} | ISO/Date -> millis (0 if unknown).
function csMillis(v) {
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v.seconds != null) return v.seconds * 1000;
  const t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}

function fmtCsDate(v) {
  const ms = csMillis(v);
  if (!ms) return "";
  try { return new Date(ms).toLocaleString(); } catch { return ""; }
}

// Short "Jun 26" style date for compact analytics rows.
function fmtCsDateShort(v) {
  const ms = csMillis(v);
  if (!ms) return "";
  try { return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }); } catch { return ""; }
}

// One round-by-round strip colored by the winning side (CT blue / T amber).
function roundStrip(rounds) {
  if (!Array.isArray(rounds) || !rounds.length) return "";
  const cells = rounds.map((r) => {
    const ct = String(r.winnerSide).toUpperCase() === "CT";
    const cls = ct ? "bg-sky-500/70" : "bg-amber-500/70";
    return `<span class="inline-block w-3 h-5 rounded-sm ${cls}" title="Round ${csNum(r.round)} · ${esc(r.winnerSide || "")}"></span>`;
  }).join("");
  return `<div class="flex flex-wrap gap-1">${cells}</div>`;
}

// Normalized, rating-sorted player rows for one extracted CS match.
function matchPlayers(cs) {
  return (cs.players || []).map(csPlayerRow).sort((a, b) => (b.rating - a.rating));
}

// The match's Player of the Match (highest rating), or null.
function matchMvp(cs) {
  return matchPlayers(cs)[0] || null;
}

function ratingCell(r) {
  const cls = r >= 1.15 ? "text-emerald-400" : r >= 1 ? "text-emerald-300" : r >= 0.85 ? "text-slate-200" : "text-red-300";
  return `<span class="font-bold ${cls}">${r.toFixed(2)}</span>`;
}

// The detailed scoreboard for one extracted CS match, sorted by rating, with the
// Player of the Match marked.
function csScoreboard(cs) {
  const rows = matchPlayers(cs);
  const mvpKey = rows[0] && rows[0].key;
  const body = rows.map((p) => `
    <tr class="border-t border-slate-800 ${p.key === mvpKey ? "bg-accent/5" : ""}">
      <td class="py-1.5 pr-2 font-medium">${p.key === mvpKey ? "👑 " : ""}${esc(p.nickname)} ${p.team ? sideBadge(p.team) : ""}</td>
      <td class="px-2 text-center font-mono">${ratingCell(p.rating)}</td>
      <td class="px-2 text-center font-mono">${p.kills}</td>
      <td class="px-2 text-center font-mono">${p.deaths}</td>
      <td class="px-2 text-center font-mono">${p.assists}</td>
      <td class="px-2 text-center font-mono">${p.deaths ? (p.kills / p.deaths).toFixed(2) : p.kills.toFixed(2)}</td>
      <td class="px-2 text-center font-mono">${p.adr.toFixed(1)}</td>
      <td class="px-2 text-center font-mono">${p.hsPct.toFixed(0)}%</td>
      <td class="px-2 text-center font-mono">${p.kast.toFixed(0)}%</td>
      <td class="px-2 text-center font-mono">${p.mvps}</td>
    </tr>`).join("");
  return `
    <div class="overflow-x-auto">
      <table class="w-full text-xs">
        <thead class="text-slate-500 uppercase tracking-wide text-[10px]">
          <tr>
            <th class="py-1 pr-2 text-left">Player</th>
            <th class="px-2" title="Approx HLTV Rating 2.0">RAT</th>
            <th class="px-2">K</th><th class="px-2">D</th><th class="px-2">A</th>
            <th class="px-2">K/D</th><th class="px-2">ADR</th><th class="px-2">HS%</th>
            <th class="px-2">KAST</th><th class="px-2">MVP</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

// The player whose per-round perspective ("won"/economy) anchors a match view —
// preferring a tracked "my team" member, then the signed-in user, then anyone.
// Returns null for an empty match.
function refPlayer(cs) {
  const players = (cs && cs.players) || [];
  const myNames = (cs && cs.myTeam && cs.myTeam.players) || [];
  return players.find((p) => myNames.includes(p.nickname))
    || (user && players.find((p) => p.userId === user.uid))
    || players[0]
    || null;
}

// Round momentum + per-team economy strip for one match. Derives "my team" from
// the tracked player so it survives the halftime side swap; degrades to "" when
// the per-round data isn't present.
function momentumPanel(cs) {
  const players = cs.players || [];
  if (!players.length) return "";
  const ref = refPlayer(cs);
  const refRounds = (ref && ref.rounds) || [];
  if (!refRounds.length) return "";

  const myLabel = (ref.team || "").toUpperCase();
  const mine = players.filter((p) => (p.team || "").toUpperCase() === myLabel);
  const enemy = players.filter((p) => (p.team || "").toUpperCase() !== myLabel);
  const half = csNum(cs.maxRounds) ? Math.floor(csNum(cs.maxRounds) / 2) : 12;

  // Economy bucket from a team's total start money for the round.
  const buy = (sum) => sum < 5000 ? { c: "bg-red-500/70", t: "eco" }
    : sum < 20000 ? { c: "bg-yellow-500/70", t: "force" }
    : { c: "bg-emerald-500/70", t: "full" };
  const teamBuyAt = (team, idx) => buy(team.reduce((s, p) => s + csNum(p.rounds && p.rounds[idx] && p.rounds[idx].startMoney), 0));

  let myScore = 0, enScore = 0;
  const resultCells = [], myEcoCells = [], enEcoCells = [];
  refRounds.forEach((r, idx) => {
    const won = !!r.won;
    if (won) myScore++; else enScore++;
    const pistol = csNum(r.round) === 1 || csNum(r.round) === half + 1;
    resultCells.push(`<span class="inline-block w-3 h-5 rounded-sm ${won ? "bg-emerald-500/80" : "bg-red-500/70"} ${pistol ? "ring-1 ring-white/60" : ""}"
      title="Round ${csNum(r.round)} · ${won ? "won" : "lost"}${pistol ? " · pistol" : ""} · ${myScore}-${enScore}"></span>`);
    const mb = teamBuyAt(mine, idx), eb = teamBuyAt(enemy, idx);
    myEcoCells.push(`<span class="inline-block w-3 h-2 rounded-sm ${mb.c}" title="Round ${csNum(r.round)} · your team ${mb.t}"></span>`);
    enEcoCells.push(`<span class="inline-block w-3 h-2 rounded-sm ${eb.c}" title="Round ${csNum(r.round)} · enemy ${eb.t}"></span>`);
  });

  const hasEco = mine.some((p) => (p.rounds || []).some((r) => csNum(r.startMoney)));
  const legend = `
    <div class="flex flex-wrap gap-3 text-[10px] text-slate-500">
      <span class="flex items-center gap-1"><span class="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-500/80"></span>won</span>
      <span class="flex items-center gap-1"><span class="inline-block w-2.5 h-2.5 rounded-sm bg-red-500/70"></span>lost</span>
      <span class="flex items-center gap-1"><span class="inline-block w-2.5 h-2.5 rounded-sm ring-1 ring-white/60"></span>pistol</span>
      ${hasEco ? `<span class="text-slate-600">·</span>
      <span class="flex items-center gap-1"><span class="inline-block w-2.5 h-2.5 rounded-sm bg-red-500/70"></span>eco</span>
      <span class="flex items-center gap-1"><span class="inline-block w-2.5 h-2.5 rounded-sm bg-yellow-500/70"></span>force</span>
      <span class="flex items-center gap-1"><span class="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-500/70"></span>full</span>` : ""}
    </div>`;

  return `
    <div class="space-y-2">
      <div class="text-[11px] text-slate-400">Momentum <span class="text-slate-600">(your team's round-by-round result)</span></div>
      <div class="flex flex-wrap gap-1">${resultCells.join("")}</div>
      ${hasEco ? `
        <div class="text-[10px] text-slate-500 mt-1">Economy · your team</div>
        <div class="flex flex-wrap gap-1">${myEcoCells.join("")}</div>
        <div class="text-[10px] text-slate-500">Economy · enemy</div>
        <div class="flex flex-wrap gap-1">${enEcoCells.join("")}</div>` : ""}
      ${legend}
    </div>`;
}

// The uploaded CS matches for a series' played maps, in play order (skips maps
// the plugin hasn't uploaded). Each played map i maps to picked map i's UUID.
function seriesCsMatches(match) {
  const ids = (match.veto && match.veto.mapIds) || [];
  return (match.mapsPlayed || [])
    .map((_, i) => ({ cs: csMatchCache[ids[i]], picked: match.veto && match.veto.picked && match.veto.picked[i], i }))
    .filter((e) => e.cs && Array.isArray(e.cs.players) && e.cs.players.length);
}

// Series MVP: the top-rated player aggregated across every uploaded map of the
// series (so a player who carried two maps outranks a one-map spike). null when
// no CS data is uploaded for the series yet.
function seriesMvp(match) {
  const entries = seriesCsMatches(match);
  if (!entries.length) return null;
  const rows = entries.flatMap(({ cs }) =>
    cs.players.map((pl) => csPlayerRow({ ...pl, map: pl.map || cs.map })));
  return aggregatePlayers(rows)[0] || null;
}

// Cumulative round-win differential (your team minus enemy) across the whole
// series, concatenating each map's rounds in play order. Returns the segments
// and the running point list, or null when no per-round data is present.
function seriesMomentum(match) {
  const entries = seriesCsMatches(match);
  if (!entries.length) return null;
  const segments = [];
  const points = [];        // running differential after each round across the series
  let diff = 0, idx = 0;
  for (const { cs, picked } of entries) {
    const ref = refPlayer(cs);
    const rounds = (ref && ref.rounds) || [];
    if (!rounds.length) continue;
    const start = idx;
    if (!points.length) points.push({ x: 0, d: 0 });
    rounds.forEach((r) => {
      diff += r.won ? 1 : -1;
      idx += 1;
      points.push({ x: idx, d: diff });
    });
    segments.push({ map: cs.map || picked || `Map ${segments.length + 1}`, start, end: idx, endDiff: diff });
  }
  return points.length > 1 ? { segments, points, total: idx } : null;
}

// SVG line chart of series momentum: x = round index across all maps, y = round
// differential (above the midline = your team ahead). Map boundaries are marked.
function seriesMomentumGraph(match) {
  const data = seriesMomentum(match);
  if (!data) return "";
  const { segments, points, total } = data;
  const W = 100, H = 40, mid = H / 2;
  const maxAbs = Math.max(1, ...points.map((p) => Math.abs(p.d)));
  const px = (x) => (x / total) * W;
  const py = (d) => mid - (d / maxAbs) * (mid - 2);
  const path = points.map((p) => `${px(p.x).toFixed(2)},${py(p.d).toFixed(2)}`).join(" ");
  // Vertical separators between maps, plus a faint zero (tied) midline.
  const seps = segments.slice(0, -1).map((s) =>
    `<line x1="${px(s.end).toFixed(2)}" y1="0" x2="${px(s.end).toFixed(2)}" y2="${H}" stroke="rgb(100 116 139 / 0.3)" stroke-width="0.4" stroke-dasharray="1.5 1.5" />`).join("");
  const endDot = (() => {
    const last = points[points.length - 1];
    const cls = last.d > 0 ? "rgb(52 211 153)" : last.d < 0 ? "rgb(248 113 113)" : "rgb(148 163 184)";
    return `<circle cx="${px(last.x).toFixed(2)}" cy="${py(last.d).toFixed(2)}" r="1" fill="${cls}" />`;
  })();
  // Per-map labels with the running differential at the end of each map.
  const labels = segments.map((s) => {
    const sign = s.endDiff > 0 ? "+" : "";
    const cls = s.endDiff > 0 ? "text-emerald-400" : s.endDiff < 0 ? "text-red-400" : "text-slate-400";
    return `<span class="flex items-center gap-1">${mapIconImg(s.map, "h-3.5 w-3.5")}<span class="text-slate-400">${esc(s.map)}</span>
      <span class="font-mono ${cls}">${sign}${s.endDiff}</span></span>`;
  }).join("");
  return `
    <div class="space-y-2">
      <div class="text-[11px] text-slate-400">Series momentum
        <span class="text-slate-600">(cumulative round lead across all maps — above the line means your team is ahead)</span></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="w-full h-24 rounded bg-slate-950/40">
        <line x1="0" y1="${mid}" x2="${W}" y2="${mid}" stroke="rgb(100 116 139 / 0.4)" stroke-width="0.4" />
        ${seps}
        <polyline points="${path}" fill="none" stroke="rgb(245 158 11)" stroke-width="1.2"
          vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
        ${endDot}
      </svg>
      <div class="flex flex-wrap gap-x-4 gap-y-1 text-[10px]">${labels}</div>
    </div>`;
}

// Combined CS summary for a series page: Series MVP badge + series momentum
// graph. Empty string until the plugin has uploaded at least one map.
function seriesCsPanel(match) {
  const graph = seriesMomentumGraph(match);
  const mvp = seriesMvp(match);
  if (!graph && !mvp) return "";
  const maps = seriesCsMatches(match).length;
  const mvpCard = mvp
    ? `<div class="bg-gradient-to-r from-accent/15 to-amber-500/10 border border-accent/40 rounded-xl p-4 flex items-center justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class="text-2xl">🏆</div>
          <div class="min-w-0">
            <div class="text-[10px] uppercase tracking-widest text-accent">Series MVP</div>
            <div class="font-bold truncate">${esc(mvp.nickname)}</div>
            <div class="text-[11px] text-slate-500">across ${mvp.matches} of ${maps} map${maps === 1 ? "" : "s"}</div>
          </div>
        </div>
        <div class="text-right shrink-0 font-mono text-sm">
          <div>${ratingCell(mvp.rating)} <span class="text-[10px] text-slate-500">rating</span></div>
          <div class="text-[11px] text-slate-400">${mvp.kills}-${mvp.deaths}-${mvp.assists} · ${mvp.adr.toFixed(0)} ADR</div>
        </div>
      </div>`
    : "";
  return `
    <div class="mt-4 bg-panel rounded-xl p-4 border border-slate-800 space-y-4">
      <div class="text-xs uppercase tracking-wide text-slate-500">Series breakdown</div>
      ${mvpCard}
      ${graph ? `<div class="pt-1">${graph}</div>` : ""}
    </div>`;
}

function renderMatchInfo() {
  if (!tournament) return renderMissingChampionship();
  const match = findMatch(tournament, urlMatchId);
  if (!match) { go(urlBracket(championshipId)); return; }
  const i = urlMapIdx;
  const uuid = match.veto && match.veto.mapIds && match.veto.mapIds[i];
  const cs = uuid && csMatchCache[uuid];
  const mapName = (match.veto && match.veto.picked && match.veto.picked[i]) || (cs && cs.map) || "Map";

  const back = { href: urlMatch(championshipId, urlMatchId), label: "Match" };
  if (!cs) {
    shell(`
      <div class="max-w-2xl mx-auto bg-panel rounded-xl p-6 border border-slate-800 text-center text-slate-400">
        No CS data found for this map yet. The plugin uploads it after the match ends.
        <div class="mt-3 font-mono text-[10px] text-slate-600">${esc(uuid || "")}</div>
      </div>`, { back });
    return;
  }

  const ct = csNum(cs.score && cs.score.ct), t = csNum(cs.score && cs.score.t);
  const winner = String(cs.winner || "").toUpperCase();
  const meta = [
    cs.map ? esc(cs.map) : "",
    `${fmtDuration(cs.durationSeconds)} min`,
    fmtCsDate(cs.endedAtUtc),
    cs.serverHostname ? `srv: ${esc(cs.serverHostname)}` : "",
  ].filter(Boolean).join(" · ");

  const mvp = matchMvp(cs);
  const mvpCard = mvp
    ? `<div class="bg-gradient-to-r from-accent/15 to-amber-500/10 border border-accent/40 rounded-xl p-4 flex items-center justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class="text-2xl">👑</div>
          <div class="min-w-0">
            <div class="text-[10px] uppercase tracking-widest text-accent">Player of the Match</div>
            <div class="font-bold truncate">${esc(mvp.nickname)} ${mvp.team ? sideBadge(mvp.team) : ""}</div>
          </div>
        </div>
        <div class="text-right shrink-0 font-mono text-sm">
          <div>${ratingCell(mvp.rating)} <span class="text-[10px] text-slate-500">rating</span></div>
          <div class="text-[11px] text-slate-400">${mvp.kills}-${mvp.deaths}-${mvp.assists} · ${mvp.adr.toFixed(0)} ADR</div>
        </div>
      </div>`
    : "";

  shell(`
    <div class="max-w-3xl mx-auto space-y-4">
      <div class="bg-panel rounded-xl p-5 border border-slate-800 text-center">
        <div class="flex items-center justify-center gap-2 text-sm font-bold">${mapIconImg(mapName, "h-7 w-7")}${esc(mapName)}</div>
        <div class="text-3xl font-black mt-2 font-mono">
          <span class="${winner === "CT" ? "text-emerald-400" : "text-slate-300"}">${ct}</span>
          <span class="text-slate-600">:</span>
          <span class="${winner === "T" ? "text-emerald-400" : "text-slate-300"}">${t}</span>
        </div>
        <div class="text-[11px] uppercase tracking-wide text-slate-500 mt-1">
          ${sideBadge("CT")} <span class="text-slate-600">vs</span> ${sideBadge("T")} · winner ${winner ? sideBadge(winner) : "—"}
        </div>
        <div class="text-[11px] text-slate-500 mt-2">${meta}</div>
      </div>
      ${mvpCard}
      <div class="bg-panel rounded-xl p-4 border border-slate-800">
        <div class="text-xs uppercase tracking-wide text-slate-500 mb-2">Momentum &amp; economy</div>
        ${momentumPanel(cs) || roundStrip(cs.rounds)}
      </div>
      <div class="bg-panel rounded-xl p-4 border border-slate-800">
        <div class="text-xs uppercase tracking-wide text-slate-500 mb-2">Scoreboard</div>
        ${csScoreboard(cs)}
      </div>
      <div class="font-mono text-[10px] text-slate-600 text-center">${esc(uuid)}</div>
    </div>`, { back });
}

// Top weapons by kills for a player's aggregated weaponKills.
function topWeapons(weapons, n = 6) {
  return Object.entries(weapons || {}).sort((a, b) => b[1] - a[1]).slice(0, n);
}

// Per-player insight panel: per-map form, top weapons, opening duels, clutches,
// and multi-kills — all rolled up across the counted matches.
function playerInsightPanel(p) {
  const maps = p.perMap || [];
  const mapRows = maps.length
    ? maps.map((m) => `
      <div class="flex items-center justify-between gap-2 text-[11px]">
        <span class="flex items-center gap-1.5 min-w-0">${mapIconImg(m.map, "h-4 w-4")}<span class="truncate">${esc(m.map)}</span></span>
        <span class="font-mono text-slate-400 shrink-0">${m.kills}-${m.deaths} · <span class="${m.kd >= 1 ? "text-emerald-400" : ""}">${m.kd.toFixed(2)} KD</span> · ${m.adr.toFixed(0)} ADR</span>
      </div>`).join("")
    : `<div class="text-[11px] text-slate-600">No per-map data.</div>`;

  const weps = topWeapons(p.weapons);
  const maxW = weps.length ? weps[0][1] : 1;
  const wepRows = weps.length
    ? weps.map(([w, n]) => `
      <div class="flex items-center gap-2 text-[11px]">
        <span class="w-20 shrink-0 truncate text-slate-300">${esc(w.replace(/_/g, " "))}</span>
        <span class="flex-1 h-2 rounded bg-slate-800 overflow-hidden"><span class="block h-full bg-accent" style="width:${Math.round((n / maxW) * 100)}%"></span></span>
        <span class="w-6 text-right font-mono text-slate-400">${n}</span>
      </div>`).join("")
    : `<div class="text-[11px] text-slate-600">No weapon data.</div>`;

  const openTotal = p.openingKills + p.openingDeaths;
  const openPct = openTotal ? Math.round((p.openingKills / openTotal) * 100) : 0;
  const clPct = p.clutchAttempts ? Math.round((p.clutchesWon / p.clutchAttempts) * 100) : 0;
  const splits = `
    <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
      <div class="flex justify-between"><span class="text-slate-500">Opening duels</span><span class="font-mono">${p.openingKills}–${p.openingDeaths} <span class="text-slate-600">(${openPct}%)</span></span></div>
      <div class="flex justify-between"><span class="text-slate-500">Clutches</span><span class="font-mono">${p.clutchesWon}/${p.clutchAttempts} <span class="text-slate-600">(${clPct}%)</span></span></div>
      <div class="flex justify-between"><span class="text-slate-500">Multi-kills</span><span class="font-mono">2K ${p.multi.k2} · 3K ${p.multi.k3} · 4K ${p.multi.k4} · 5K ${p.multi.k5}</span></div>
      <div class="flex justify-between"><span class="text-slate-500">Utility dmg</span><span class="font-mono">${p.utilityDamage}</span></div>
    </div>`;

  return `
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 p-3 bg-slate-950/40 rounded-lg">
      <div class="space-y-1.5">
        <div class="text-[10px] uppercase tracking-wide text-slate-500">Per-map form</div>
        ${mapRows}
      </div>
      <div class="space-y-1.5">
        <div class="text-[10px] uppercase tracking-wide text-slate-500">Top weapons</div>
        ${wepRows}
      </div>
      <div class="sm:col-span-2 pt-1 border-t border-slate-800">${splits}</div>
    </div>`;
}

// Side-by-side comparison of two aggregated players.
function comparePanel(players) {
  const a = players.find((p) => p.key === compareKeys[0]);
  const b = players.find((p) => p.key === compareKeys[1]);
  if (!a || !b) return "";
  // metric: [label, valueFn, higherIsBetter, fmt]
  const metrics = [
    ["Rating", (p) => p.rating, true, (v) => v.toFixed(2)],
    ["K/D", (p) => p.kd, true, (v) => v.toFixed(2)],
    ["ADR", (p) => p.adr, true, (v) => v.toFixed(1)],
    ["KAST", (p) => p.kast, true, (v) => v.toFixed(0) + "%"],
    ["HS%", (p) => p.hsPct, true, (v) => v.toFixed(0) + "%"],
    ["Opening +/-", (p) => p.openingKills - p.openingDeaths, true, (v) => (v > 0 ? "+" : "") + v],
    ["Clutches", (p) => p.clutchesWon, true, (v) => String(v)],
    ["Matches", (p) => p.matches, true, (v) => String(v)],
  ];
  const win = "text-emerald-400 font-bold";
  const rows = metrics.map(([label, fn, hib, fmt]) => {
    const va = fn(a), vb = fn(b);
    const aWins = hib ? va > vb : va < vb, bWins = hib ? vb > va : vb < va;
    return `
      <div class="grid grid-cols-3 items-center text-xs py-1 border-t border-slate-800">
        <span class="text-right font-mono ${aWins ? win : "text-slate-300"}">${fmt(va)}</span>
        <span class="text-center text-[10px] uppercase tracking-wide text-slate-500">${esc(label)}</span>
        <span class="text-left font-mono ${bWins ? win : "text-slate-300"}">${fmt(vb)}</span>
      </div>`;
  }).join("");
  return `
    <div class="bg-panel rounded-xl p-4 border border-accent/40 space-y-1">
      <div class="grid grid-cols-3 items-center text-sm font-bold">
        <span class="text-right truncate">${esc(a.nickname)}</span>
        <span class="text-center text-[10px] uppercase tracking-widest text-accent">Head-to-head</span>
        <span class="text-left truncate">${esc(b.nickname)}</span>
      </div>
      ${rows}
      <div class="text-center pt-1">
        <button data-action="clear-compare" class="text-[11px] text-slate-500 hover:text-red-400 transition">Clear comparison</button>
      </div>
    </div>`;
}

// Leaderboard table shared by both dashboard scopes. Rows expand to an insight
// panel; the checkbox selects players for head-to-head comparison.
function dashboardTable(players, { potm = false } = {}) {
  if (!players.length) {
    return `<p class="text-slate-500 text-sm">No CS match data yet. Play a map, then import your plugin's upload from the match screen and it will appear here.</p>`;
  }
  const colspan = potm ? 14 : 13;
  const body = players.map((p, idx) => {
    const open = expandedPlayer === p.key;
    const checked = compareKeys.includes(p.key);
    const potmCell = potm
      ? `<td class="px-2 text-center font-mono ${p.potm ? "text-accent font-bold" : "text-slate-500"}">${p.potm ? `👑 ${p.potm}` : "—"}</td>`
      : "";
    const row = `
    <tr class="border-t border-slate-800 ${open ? "bg-slate-800/30" : ""}">
      <td class="py-1.5 pr-1 text-center">
        <button data-action="toggle-compare" data-key="${esc(p.key)}" title="Compare"
          class="w-4 h-4 rounded border ${checked ? "bg-accent border-accent" : "border-slate-600 hover:border-slate-400"} text-ink text-[9px] leading-none">${checked ? "✓" : ""}</button>
      </td>
      <td class="py-1.5 pr-2 text-slate-500 text-center font-mono">${idx + 1}</td>
      <td class="py-1.5 pr-2 font-medium">
        <button data-action="toggle-player" data-key="${esc(p.key)}" class="hover:text-accent transition text-left">
          ${open ? "▾" : "▸"} ${esc(p.nickname)}</button>
      </td>
      <td class="px-2 text-center font-mono">${ratingCell(p.rating)}</td>
      <td class="px-2 text-center font-mono">${p.matches}</td>
      <td class="px-2 text-center font-mono">${p.kills}</td>
      <td class="px-2 text-center font-mono">${p.deaths}</td>
      <td class="px-2 text-center font-mono">${p.assists}</td>
      <td class="px-2 text-center font-mono font-bold ${p.kd >= 1 ? "text-emerald-400" : "text-slate-300"}">${p.kd.toFixed(2)}</td>
      <td class="px-2 text-center font-mono">${p.adr.toFixed(1)}</td>
      <td class="px-2 text-center font-mono">${p.hsPct.toFixed(0)}%</td>
      <td class="px-2 text-center font-mono">${p.kast.toFixed(0)}%</td>
      <td class="px-2 text-center font-mono">${p.mvps}</td>
      ${potmCell}
    </tr>`;
    const detail = open
      ? `<tr><td colspan="${colspan}" class="px-2 pb-3">${playerInsightPanel(p)}</td></tr>`
      : "";
    return row + detail;
  }).join("");
  // Hover tooltips explaining each column. A styled popup appears below the
  // header on hover (placed below so the table's overflow-x container doesn't
  // clip it); the native `title` stays as an accessibility fallback. `extra`
  // carries per-cell layout classes (padding / alignment).
  const th = (label, tip, extra = "px-2") =>
    `<th class="${extra} relative">
      <span class="group inline-flex items-center justify-center gap-0.5 cursor-help" title="${esc(tip)}">
        <span class="border-b border-dotted border-slate-500">${label}</span>
        <span class="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-1 z-30 hidden group-hover:block
          w-44 normal-case tracking-normal text-left rounded-md bg-slate-950 border border-slate-700 px-2.5 py-1.5
          text-[11px] leading-snug font-normal text-slate-200 shadow-xl whitespace-normal">${esc(tip)}</span>
      </span>
    </th>`;
  return `
    <div class="overflow-x-auto">
      <table class="w-full text-xs">
        <thead class="text-slate-500 uppercase tracking-wide text-[10px]">
          <tr>
            <th class="py-1 pr-1"></th>
            <th class="py-1 pr-2">#</th>
            ${th("Player", "In-game player nickname. Click a row to expand per-map form, top weapons, opening duels, clutches and multi-kills.", "py-1 pr-2 text-left")}
            ${th("RAT", "Rating — approximate HLTV Rating 2.0 from KAST, per-round kills/deaths/assists, impact and ADR. ~1.00 is average; 1.15+ is excellent.")}
            ${th("M", "Matches — number of maps with uploaded CS data counted for this player.")}
            ${th("K", "Kills — total enemy kills across all counted maps.")}
            ${th("D", "Deaths — total times this player died.")}
            ${th("A", "Assists — total kills this player helped secure (damage or flash assists).")}
            ${th("K/D", "Kill/Death ratio — total kills divided by total deaths. Above 1.00 means more kills than deaths.")}
            ${th("ADR", "Average Damage per Round — total damage dealt divided by rounds played (round-weighted across maps). ~85+ is strong.")}
            ${th("HS%", "Headshot percentage — share of this player's kills that were headshots.")}
            ${th("KAST", "Share of rounds with a Kill, Assist, Survived, or was Traded — a consistency/impact measure. ~70%+ is good.")}
            ${th("MVP", "Most Valuable Player awards — rounds where this player had the biggest impact.")}
            ${potm ? th("POTM", "Player of the Match — maps in this championship where this player finished with the top rating.") : ""}
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

// Highest multi-kill tier (5/4/3/2) a player reached in one game, or 0.
function maxMultiKill(multi) {
  for (const [tier, k] of [[5, "k5"], [4, "k4"], [3, "k3"], [2, "k2"]]) {
    if (csNum(multi && multi[k]) > 0) return tier;
  }
  return 0;
}

// "Personal records wall" — the user's best single-map performances pulled from
// their per-player-match docs (one doc = one map they played). Each card names
// the map and date the record was set. Shown only on the all-time (global)
// scope, where every row is the signed-in user's own game.
function personalRecordsWall(rawDocs) {
  const games = (rawDocs || []).map((d) => ({ row: csPlayerRow(d), date: d.endedAtUtc }));
  if (!games.length) return "";

  // [icon, label, metric, formatter] — metric returns 0/null to skip a game.
  const specs = [
    ["🎯", "Best rating", (r) => r.rating, (v) => v.toFixed(2)],
    ["💀", "Most kills", (r) => r.kills, (v) => String(v)],
    ["⚔️", "Best K/D", (r) => (r.deaths ? r.kills / r.deaths : r.kills), (v) => v.toFixed(2)],
    ["🔥", "Top ADR", (r) => r.adr, (v) => v.toFixed(0)],
    ["🚪", "Opening kills", (r) => r.openingKills, (v) => String(v)],
    ["🧊", "Clutches won", (r) => r.clutchesWon, (v) => String(v)],
    ["💥", "Biggest multi-kill", (r) => maxMultiKill(r.multiKills), (v) => `${v}K`],
    ["🎯", "Best HS%", (r) => (r.kills >= 5 ? r.hsPct : 0), (v) => `${v.toFixed(0)}%`],
  ];

  const cards = specs.map(([icon, label, metric, fmt]) => {
    let best = null, bestVal = 0;
    for (const g of games) {
      const v = metric(g.row);
      if (v > bestVal) { bestVal = v; best = g; }
    }
    if (!best || bestVal <= 0) return "";
    const mapName = best.row.map || "";
    const when = fmtCsDate(best.date);
    const ctx = [mapName, when].filter(Boolean).join(" · ");
    return `
      <div class="rounded-lg bg-slate-950/40 border border-slate-800 p-3 flex flex-col gap-0.5">
        <div class="text-[10px] uppercase tracking-wide text-slate-500 flex items-center gap-1"><span>${icon}</span>${esc(label)}</div>
        <div class="text-xl font-black font-mono text-accent leading-tight">${fmt(bestVal)}</div>
        <div class="text-[10px] text-slate-500 flex items-center gap-1 min-w-0">
          ${mapName ? mapIconImg(mapName, "h-3.5 w-3.5") : ""}<span class="truncate">${esc(ctx)}</span>
        </div>
      </div>`;
  }).filter(Boolean).join("");

  if (!cards) return "";
  return `
    <div class="bg-panel rounded-xl p-4 border border-slate-800 space-y-3">
      <div>
        <div class="text-sm font-bold">🏅 Personal records</div>
        <div class="text-xs text-slate-500">Your best single-map performances across every championship</div>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">${cards}</div>
    </div>`;
}

// Normalize one per-player-match doc into a "game" used by the historic
// analytics: the flat stat row plus a date, a derived map win/loss result, and
// CT/T round splits. Win/loss prefers the doc's teamScore/enemyScore, falling
// back to counting rounds[].won. Per-round side is derived from won + winnerSide
// (no halftime math needed): a won round was played on the winning side.
function normalizeGame(d) {
  const row = csPlayerRow(d);
  const rounds = Array.isArray(d.rounds) ? d.rounds : [];
  let teamScore = null, enemyScore = null, result = null;
  if (d.teamScore != null && d.enemyScore != null) {
    teamScore = csNum(d.teamScore); enemyScore = csNum(d.enemyScore);
  } else if (rounds.length) {
    teamScore = rounds.filter((r) => r.won).length;
    enemyScore = rounds.length - teamScore;
  }
  if (teamScore != null) result = teamScore > enemyScore ? "W" : teamScore < enemyScore ? "L" : "T";

  let ctPlayed = 0, ctWon = 0, tPlayed = 0, tWon = 0;
  for (const r of rounds) {
    const ws = String(r.winnerSide || "").toUpperCase();
    if (ws !== "CT" && ws !== "T") continue;
    const won = !!r.won;
    const side = won ? ws : ws === "CT" ? "T" : "CT";
    if (side === "CT") { ctPlayed++; if (won) ctWon++; }
    else { tPlayed++; if (won) tWon++; }
  }
  return {
    ...row,
    date: csMillis(d.endedAtUtc), rawDate: d.endedAtUtc, result, teamScore, enemyScore,
    kd: row.deaths ? row.kills / row.deaths : row.kills,
    ctPlayed, ctWon, tPlayed, tWon,
  };
}

// Metrics the time-series chart can plot. `get` reads one game's value (null =
// not applicable, e.g. a tied game has no win-rate point); `ref` is an optional
// dashed reference line; `rollingOnly` hides noisy per-game dots (win-rate is
// only meaningful as a moving rate, not a 0/100 scatter).
const TREND_METRICS = [
  { key: "rating",  label: "Rating", ref: 1.0,  get: (g) => g.rating, fmt: (v) => v.toFixed(2) },
  { key: "kd",      label: "K/D",    ref: 1.0,  get: (g) => g.kd,     fmt: (v) => v.toFixed(2) },
  { key: "adr",     label: "ADR",    ref: null, get: (g) => g.adr,    fmt: (v) => v.toFixed(0) },
  { key: "kast",    label: "KAST",   ref: null, get: (g) => g.kast,   fmt: (v) => v.toFixed(0) + "%" },
  { key: "hs",      label: "HS%",    ref: null, get: (g) => g.hsPct,  fmt: (v) => v.toFixed(0) + "%" },
  { key: "winrate", label: "Win%",   ref: 50,   rollingOnly: true,
    get: (g) => (g.result === "W" ? 100 : g.result === "L" ? 0 : null), fmt: (v) => v.toFixed(0) + "%" },
];

function fmtDayShort(ms) {
  try { return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }); } catch { return ""; }
}

// Time-series chart of one selectable metric across the player's games. The
// x-axis is real time when dates are available (so quiet stretches show as
// gaps), otherwise game order. Each game is a win/loss-colored dot and a
// moving-average line draws the underlying trend. `metricKey` is the active tab.
function performanceTrends(games, metricKey) {
  if (games.length < 3) return "";

  // Only offer a metric if enough games carry a usable value for it.
  const decided = games.filter((g) => g.result === "W" || g.result === "L").length;
  const avail = TREND_METRICS.filter((m) =>
    m.key === "winrate"
      ? decided >= 3
      : games.filter((g) => { const v = m.get(g); return v != null && !isNaN(v) && v > 0; }).length >= 3
  );
  const metric = avail.find((m) => m.key === metricKey) || avail[0];
  if (!metric) return "";

  const pts = [];
  games.forEach((g, i) => {
    const v = metric.get(g);
    if (v == null || isNaN(v)) return;
    if (metric.key !== "winrate" && !(v > 0)) return;
    pts.push({ i, date: g.date, v, result: g.result });
  });
  if (pts.length < 3) return "";

  // Moving average over the most recent `win` points at each step.
  const win = Math.min(7, Math.max(3, Math.round(pts.length / 5)));
  const roll = pts.map((p, idx) => {
    const seg = pts.slice(Math.max(0, idx - win + 1), idx + 1);
    return seg.reduce((s, q) => s + q.v, 0) / seg.length;
  });

  // y domain from the data (plus the reference line), padded so points breathe.
  const allV = pts.map((p) => p.v).concat(roll);
  if (metric.ref != null) allV.push(metric.ref);
  let lo = Math.min(...allV), hi = Math.max(...allV);
  const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 1;
  lo -= pad; hi += pad;
  if (metric.key === "winrate" || metric.key === "kast" || metric.key === "hs") { lo = Math.max(0, lo); hi = Math.min(100, hi); }

  // x in real time when most points are dated and the span is non-zero.
  const dated = pts.filter((p) => p.date > 0);
  const useTime = dated.length >= pts.length * 0.6 && dated.length >= 2 &&
    (dated[dated.length - 1].date - dated[0].date) > 0;
  const xv = (p) => (useTime ? p.date : p.i);
  const xs = pts.map(xv);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);

  const W = 480, H = 168, padL = 36, padR = 10, padT = 12, padB = 24;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (p) => padL + ((xv(p) - xmin) / (xmax - xmin || 1)) * plotW;
  const Y = (v) => padT + (1 - (v - lo) / (hi - lo || 1)) * plotH;

  const grid = [hi, (hi + lo) / 2, lo].map((gv) => `
    <line x1="${padL}" y1="${Y(gv).toFixed(1)}" x2="${W - padR}" y2="${Y(gv).toFixed(1)}" stroke="rgb(100 116 139 / 0.18)" stroke-width="0.5"/>
    <text x="${padL - 4}" y="${(Y(gv) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="rgb(100 116 139)">${esc(metric.fmt(gv))}</text>`).join("");

  const refLine = (metric.ref != null && metric.ref >= lo && metric.ref <= hi)
    ? `<line x1="${padL}" y1="${Y(metric.ref).toFixed(1)}" x2="${W - padR}" y2="${Y(metric.ref).toFixed(1)}" stroke="rgb(148 163 184 / 0.6)" stroke-width="0.7" stroke-dasharray="3 3"/>`
    : "";

  const dots = metric.rollingOnly ? "" : pts.map((p) => {
    const c = p.result === "W" ? "rgb(52 211 153)" : p.result === "L" ? "rgb(248 113 113)" : "rgb(148 163 184)";
    return `<circle cx="${X(p).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="1.7" fill="${c}" opacity="0.7"/>`;
  }).join("");

  const rollPath = pts.map((p, idx) => `${X(p).toFixed(1)},${Y(roll[idx]).toFixed(1)}`).join(" ");
  const line = `<polyline points="${rollPath}" fill="none" stroke="rgb(245 158 11)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;

  const mid = pts[Math.floor((pts.length - 1) / 2)];
  const xText = (p) => (useTime ? fmtDayShort(p.date) : `Game ${p.i + 1}`);
  const xLabels = `
    <text x="${X(pts[0]).toFixed(1)}" y="${H - 8}" text-anchor="start" font-size="9" fill="rgb(100 116 139)">${esc(xText(pts[0]))}</text>
    <text x="${X(mid).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="9" fill="rgb(100 116 139)">${esc(xText(mid))}</text>
    <text x="${X(pts[pts.length - 1]).toFixed(1)}" y="${H - 8}" text-anchor="end" font-size="9" fill="rgb(100 116 139)">${esc(xText(pts[pts.length - 1]))}</text>`;

  const tabs = avail.map((m) => {
    const on = m.key === metric.key;
    return `<button data-action="dash-metric" data-metric="${m.key}" class="px-2.5 py-1 rounded-md text-[11px] font-semibold transition ${on ? "bg-accent text-ink" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}">${esc(m.label)}</button>`;
  }).join("");

  return `
    <div class="space-y-2">
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <div class="text-[11px] uppercase tracking-wide text-slate-500">${esc(metric.label)} over time</div>
        <div class="flex gap-1 flex-wrap">${tabs}</div>
      </div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="w-full h-auto rounded bg-slate-950/40">
        ${grid}
        ${refLine}
        ${line}
        ${dots}
        ${xLabels}
      </svg>
      <div class="text-[10px] text-slate-600">${win}-game moving average (amber)${metric.rollingOnly ? "" : " · green win / red loss · each dot is one map"}${metric.ref != null ? ` · dashed = ${esc(metric.fmt(metric.ref))}` : ""}</div>
    </div>`;
}

// Per-map record table: maps played, W-L, win%, avg rating, K/D, ADR.
function mapPerformanceTable(games) {
  const byMap = new Map();
  for (const g of games) {
    const m = g.map || "Unknown";
    let s = byMap.get(m);
    if (!s) { s = { map: m, n: 0, w: 0, l: 0, kills: 0, deaths: 0, rounds: 0, adrSum: 0, ratingSum: 0 }; byMap.set(m, s); }
    s.n++; if (g.result === "W") s.w++; else if (g.result === "L") s.l++;
    s.kills += g.kills; s.deaths += g.deaths; s.rounds += g.rounds;
    s.adrSum += g.adr * g.rounds; s.ratingSum += g.rating;
  }
  const rows = [...byMap.values()].map((s) => ({
    ...s,
    winPct: s.n ? (s.w / s.n) * 100 : 0,
    kd: s.deaths ? s.kills / s.deaths : s.kills,
    adr: s.rounds ? s.adrSum / s.rounds : 0,
    rating: s.n ? s.ratingSum / s.n : 0,
  })).sort((a, b) => b.n - a.n);
  if (!rows.length) return "";
  const body = rows.map((r) => `
    <tr class="border-t border-slate-800">
      <td class="py-1.5 pr-2"><span class="flex items-center gap-1.5">${mapIconImg(r.map, "h-4 w-4")}${esc(r.map)}</span></td>
      <td class="px-2 text-center font-mono">${r.n}</td>
      <td class="px-2 text-center font-mono text-slate-400">${r.w}-${r.l}</td>
      <td class="px-2 text-center font-mono ${r.winPct >= 50 ? "text-emerald-400" : "text-slate-300"}">${r.winPct.toFixed(0)}%</td>
      <td class="px-2 text-center font-mono">${ratingCell(r.rating)}</td>
      <td class="px-2 text-center font-mono ${r.kd >= 1 ? "text-emerald-400" : "text-slate-300"}">${r.kd.toFixed(2)}</td>
      <td class="px-2 text-center font-mono">${r.adr.toFixed(0)}</td>
    </tr>`).join("");
  return `
    <div class="overflow-x-auto"><table class="w-full text-xs">
      <thead class="text-slate-500 uppercase tracking-wide text-[10px]"><tr>
        <th class="py-1 pr-2 text-left">Map</th><th class="px-2">M</th><th class="px-2">W-L</th>
        <th class="px-2">Win%</th><th class="px-2">RAT</th><th class="px-2">K/D</th><th class="px-2">ADR</th>
      </tr></thead><tbody>${body}</tbody></table></div>`;
}

// CT vs T round-win-rate bars aggregated across all games.
function sideSplitPanel(games) {
  let ctP = 0, ctW = 0, tP = 0, tW = 0;
  for (const g of games) { ctP += g.ctPlayed; ctW += g.ctWon; tP += g.tPlayed; tW += g.tWon; }
  if (!ctP && !tP) return "";
  const ctPct = ctP ? (ctW / ctP) * 100 : 0, tPct = tP ? (tW / tP) * 100 : 0;
  const bar = (label, pct, played, won, color) => `
    <div class="space-y-1">
      <div class="flex justify-between text-[11px]"><span class="text-slate-400">${label}</span>
        <span class="font-mono text-slate-300">${won}/${played} · ${pct.toFixed(0)}%</span></div>
      <div class="h-2 rounded bg-slate-800 overflow-hidden"><span class="block h-full ${color}" style="width:${pct.toFixed(0)}%"></span></div>
    </div>`;
  return `
    <div class="space-y-2">
      <div class="text-[11px] text-slate-400">Round win rate by side</div>
      ${bar("CT side", ctPct, ctP, ctW, "bg-sky-500/80")}
      ${bar("T side", tPct, tP, tW, "bg-amber-500/80")}
    </div>`;
}

// Chronological match history (newest first), capped at `limit`.
function matchHistoryList(games, limit = 20) {
  const recent = [...games].reverse().slice(0, limit);
  if (!recent.length) return "";
  const rows = recent.map((g) => {
    const res = g.result === "W" ? `<span class="text-emerald-400 font-bold">W</span>`
      : g.result === "L" ? `<span class="text-red-400 font-bold">L</span>`
      : `<span class="text-slate-500">–</span>`;
    const score = g.teamScore != null ? `${g.teamScore}-${g.enemyScore}` : "";
    return `
      <tr class="border-t border-slate-800">
        <td class="py-1.5 pr-2 text-slate-500 whitespace-nowrap">${esc(fmtCsDateShort(g.rawDate))}</td>
        <td class="px-2"><span class="flex items-center gap-1.5 min-w-0">${mapIconImg(g.map, "h-4 w-4")}<span class="truncate">${esc(g.map || "—")}</span></span></td>
        <td class="px-2 text-center">${res}</td>
        <td class="px-2 text-center font-mono text-slate-400">${score}</td>
        <td class="px-2 text-center font-mono">${ratingCell(g.rating)}</td>
        <td class="px-2 text-center font-mono text-slate-300">${g.kills}-${g.deaths}-${g.assists}</td>
        <td class="px-2 text-center font-mono text-slate-400">${g.adr.toFixed(0)}</td>
      </tr>`;
  }).join("");
  const more = games.length > limit ? `<div class="text-[10px] text-slate-600 mt-1">Showing ${limit} of ${games.length} maps.</div>` : "";
  return `
    <div class="overflow-x-auto"><table class="w-full text-xs">
      <thead class="text-slate-500 uppercase tracking-wide text-[10px]"><tr>
        <th class="py-1 pr-2 text-left">Date</th><th class="px-2 text-left">Map</th><th class="px-2">Res</th>
        <th class="px-2">Score</th><th class="px-2">RAT</th><th class="px-2">K-D-A</th><th class="px-2">ADR</th>
      </tr></thead><tbody>${rows}</tbody></table></div>${more}`;
}

// Auto-generated "intelligence" bullets derived from the player's history and
// aggregate (`me`): form trend, best/worst map, side preference, role/playstyle,
// signature weapon, and consistency. Each gates on enough sample size.
function playerInsights(games, me) {
  const out = [];
  if (!games.length || !me) return out;
  const avgOf = (arr) => arr.reduce((s, g) => s + g.rating, 0) / arr.length;

  if (games.length >= 6) {
    const recentAvg = avgOf(games.slice(-5)), allAvg = avgOf(games), delta = recentAvg - allAvg;
    if (Math.abs(delta) >= 0.05) out.push(delta > 0
      ? { icon: "📈", text: `Trending up — last 5 maps average ${recentAvg.toFixed(2)} rating, ${delta.toFixed(2)} above your norm.` }
      : { icon: "📉", text: `In a dip — last 5 maps average ${recentAvg.toFixed(2)} rating, ${Math.abs(delta).toFixed(2)} below your norm.` });
  }

  const mapStats = new Map();
  for (const g of games) { const m = g.map || "Unknown"; const s = mapStats.get(m) || { n: 0, sum: 0, w: 0 }; s.n++; s.sum += g.rating; if (g.result === "W") s.w++; mapStats.set(m, s); }
  const ranked = [...mapStats.entries()].filter(([, s]) => s.n >= 2)
    .map(([m, s]) => ({ map: m, avg: s.sum / s.n, n: s.n, winPct: (s.w / s.n) * 100 }))
    .sort((a, b) => b.avg - a.avg);
  if (ranked.length) { const best = ranked[0]; out.push({ icon: "⭐", text: `Strongest map: ${best.map} — ${best.avg.toFixed(2)} rating over ${best.n} maps (${best.winPct.toFixed(0)}% wins).` }); }
  if (ranked.length >= 3) { const worst = ranked[ranked.length - 1]; out.push({ icon: "⚠️", text: `Weakest map: ${worst.map} — ${worst.avg.toFixed(2)} rating over ${worst.n} maps. Worth practising.` }); }

  let ctP = 0, ctW = 0, tP = 0, tW = 0;
  for (const g of games) { ctP += g.ctPlayed; ctW += g.ctWon; tP += g.tPlayed; tW += g.tWon; }
  if (ctP >= 10 && tP >= 10) {
    const ctPct = (ctW / ctP) * 100, tPct = (tW / tP) * 100;
    if (Math.abs(ctPct - tPct) >= 8) out.push(ctPct > tPct
      ? { icon: "🛡️", text: `Stronger on CT side — ${ctPct.toFixed(0)}% round wins vs ${tPct.toFixed(0)}% on T.` }
      : { icon: "🔫", text: `Stronger on T side — ${tPct.toFixed(0)}% round wins vs ${ctPct.toFixed(0)}% on CT.` });
  }

  const openTot = me.openingKills + me.openingDeaths;
  if (openTot >= 20) {
    const op = (me.openingKills / openTot) * 100, perMap = me.openingKills / me.matches;
    if (op >= 55 && perMap >= 3) out.push({ icon: "🚪", text: `Entry-fragger profile — wins ${op.toFixed(0)}% of opening duels (${perMap.toFixed(1)}/map).` });
  }
  if (me.clutchAttempts >= 8) {
    const cl = (me.clutchesWon / me.clutchAttempts) * 100;
    if (cl >= 40) out.push({ icon: "🧊", text: `Clutch specialist — ${me.clutchesWon}/${me.clutchAttempts} clutches won (${cl.toFixed(0)}%).` });
  }
  const weps = topWeapons(me.weapons, 1);
  if (weps.length && weps[0][1] >= 10) { const [w, n] = weps[0]; const isAwp = /awp/i.test(w); out.push({ icon: isAwp ? "🎯" : "🔧", text: `${isAwp ? "AWP main" : "Signature weapon"}: ${w.replace(/_/g, " ")} — ${n} kills.` }); }
  if (me.matches >= 5 && me.utilityDamage / me.matches >= 60 && me.assists / me.matches >= 6)
    out.push({ icon: "🤝", text: `Support tendencies — high utility damage (${Math.round(me.utilityDamage / me.matches)}/map) and assists.` });

  if (games.length >= 6) {
    const avg = avgOf(games), sd = Math.sqrt(games.reduce((s, g) => s + (g.rating - avg) ** 2, 0) / games.length);
    out.push(sd <= 0.18
      ? { icon: "🎚️", text: `Consistent performer — low rating variance (σ ${sd.toFixed(2)}).` }
      : { icon: "🎢", text: `Streaky — high rating swings (σ ${sd.toFixed(2)}); big games and quiet ones.` });
  }
  return out;
}

// "Player Intelligence" — historic analysis of the signed-in user's per-map
// records (`rawDocs`) plus their all-time aggregate (`me`): summary, rating
// trend, insights, side split, per-map record, and recent match history.
function playerIntelligence(rawDocs, me) {
  const games = (rawDocs || []).map(normalizeGame)
    .filter((g) => g.rounds > 0 || g.kills || g.deaths)
    .sort((a, b) => a.date - b.date);   // oldest → newest
  if (games.length < 2) return "";

  const decided = games.filter((g) => g.result === "W" || g.result === "L");
  const wins = decided.filter((g) => g.result === "W").length;
  const losses = decided.length - wins;
  const winPct = decided.length ? (wins / decided.length) * 100 : 0;

  let streak = 0, streakType = null;
  for (let i = games.length - 1; i >= 0; i--) {
    const r = games[i].result;
    if (r !== "W" && r !== "L") continue;
    if (streakType === null) { streakType = r; streak = 1; }
    else if (r === streakType) streak++;
    else break;
  }
  const streakTxt = streakType ? `${streak}${streakType}` : "—";

  const insights = playerInsights(games, me);
  const insightHtml = insights.length
    ? `<ul class="space-y-1.5">${insights.map((it) => `<li class="flex gap-2 text-xs text-slate-300"><span class="shrink-0">${it.icon}</span><span>${esc(it.text)}</span></li>`).join("")}</ul>`
    : `<div class="text-xs text-slate-500">Play a few more maps to unlock insights.</div>`;

  const stat = (label, value, sub = "") => `
    <div class="rounded-lg bg-slate-950/40 border border-slate-800 p-3 text-center">
      <div class="text-[10px] uppercase tracking-wide text-slate-500">${label}</div>
      <div class="text-xl font-black font-mono leading-tight">${value}</div>
      ${sub ? `<div class="text-[10px] text-slate-500">${sub}</div>` : ""}
    </div>`;

  return `
    <div class="bg-panel rounded-xl p-4 border border-slate-800 space-y-4">
      <div>
        <div class="text-sm font-bold">🧠 Player Intelligence</div>
        <div class="text-xs text-slate-500">Historic analysis across ${games.length} maps with round data</div>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        ${stat("Maps", String(games.length))}
        ${stat("Record", `${wins}-${losses}`, decided.length ? `${winPct.toFixed(0)}% win` : "")}
        ${stat("Avg rating", me ? me.rating.toFixed(2) : "—")}
        ${stat("Current streak", streakTxt, streakType === "W" ? "on a roll" : streakType === "L" ? "bounce back" : "")}
      </div>
      ${performanceTrends(games, dashboardMetric)}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="space-y-2">
          <div class="text-[11px] uppercase tracking-wide text-slate-500">Insights</div>
          ${insightHtml}
        </div>
        <div class="space-y-3">${sideSplitPanel(games)}</div>
      </div>
      <div class="space-y-2">
        <div class="text-[11px] uppercase tracking-wide text-slate-500">Map performance</div>
        ${mapPerformanceTable(games)}
      </div>
      <div class="space-y-2">
        <div class="text-[11px] uppercase tracking-wide text-slate-500">Recent matches</div>
        ${matchHistoryList(games)}
      </div>
    </div>`;
}

function renderDashboard() {
  const scope = urlScope;
  // The per-championship view needs a championship id; offer that tab only when
  // we have one (loaded from ?id=, present when arriving from a bracket).
  const canChampionship = !!championshipId;

  const tab = (key, label, enabled, href) => {
    const active = scope === key;
    if (!enabled) return "";
    const cls = `px-3 py-1.5 rounded-lg text-sm font-semibold transition ${active ? "bg-accent text-ink" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`;
    return `<a href="${esc(href)}" class="${cls}">${esc(label)}</a>`;
  };

  // Build the per-match rows for the active scope, then aggregate by player.
  let rows = [], subtitle, recordsWall = "";
  const potmByKey = {};   // championship scope: maps each player was top-rated in
  if (scope === "championship") {
    const uuids = new Set(allMapUuids(tournament));
    for (const id of uuids) {
      const cs = csMatchCache[id];
      // Inject the match's map onto each player so per-map form can aggregate.
      if (cs && Array.isArray(cs.players)) {
        rows.push(...cs.players.map((pl) => csPlayerRow({ ...pl, map: pl.map || cs.map })));
        const mvp = matchMvp(cs);
        if (mvp) potmByKey[mvp.key] = (potmByKey[mvp.key] || 0) + 1;
      }
    }
    subtitle = `${esc(championshipName || "Championship")} · players across all maps with uploaded CS data`;
  } else {
    rows = (csGlobalStats || []).map(csPlayerRow);
    subtitle = "Your all-time stats across every championship";
    recordsWall = personalRecordsWall(csGlobalStats);
  }
  const players = aggregatePlayers(rows);
  if (scope === "championship") players.forEach((p) => { p.potm = potmByKey[p.key] || 0; });
  // Historic / intelligence analytics — global scope only, where every row is
  // the signed-in user's own game (so win/loss and trends are personal).
  const intelligence = scope === "global" ? playerIntelligence(csGlobalStats, players[0]) : "";

  // Keep compare selection valid against the players actually present.
  compareKeys = compareKeys.filter((k) => players.some((p) => p.key === k));
  const compare = compareKeys.length === 2 ? comparePanel(players) : "";
  const hint = players.length
    ? `<div class="text-[11px] text-slate-500">Click a player for per-map form, weapons &amp; clutch stats · tick two to compare.</div>`
    : "";

  let table = dashboardTable(players, { potm: scope === "championship" });
  if (dashboardLoading) {
    table = `<p class="text-slate-400 text-sm">Loading stats…</p>`;
  } else if (dashboardError) {
    table = `
      <div class="rounded-lg bg-red-500/10 border border-red-500/40 p-3 text-sm text-red-300 space-y-1">
        <div class="font-semibold">Couldn't load CS stats.</div>
        <div class="text-red-300/80 font-mono text-xs break-all">${esc(dashboardError)}</div>
        <div class="text-slate-400 text-xs">If this says <span class="font-mono">permission-denied</span>, the Firestore rules granting read access to the CS extractor collections aren't deployed yet — run <span class="font-mono">npm run deploy:rules</span>.</div>
      </div>`;
  }

  // Back target depends on where the user came from.
  const back = championshipId
    ? { href: urlBracket(championshipId), label: "Bracket" }
    : { href: urlHome(), label: "Home" };

  shell(`
    <div class="max-w-4xl mx-auto space-y-4">
      <div class="flex items-center gap-2">
        ${tab("championship", "This Championship", canChampionship, urlDashboard("championship", championshipId))}
        ${tab("global", "All-time (me)", true, urlDashboard("global"))}
      </div>
      ${compare}
      ${recordsWall}
      ${intelligence}
      <div class="bg-panel rounded-xl p-4 border border-slate-800 space-y-3">
        <div>
          <div class="text-sm font-bold">Player Dashboard</div>
          <div class="text-xs text-slate-500">${subtitle}</div>
        </div>
        ${hint}
        ${table}
      </div>
    </div>`, { back });
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
      pendingName = "";
      pendingFormat = DEFAULT_FORMAT;
      homeView = "name";
      return render();

    // Pick a format on the name screen, preserving the typed name across the
    // re-render that highlights the selection.
    case "set-format": {
      const input = document.querySelector("[data-name-input]");
      if (input) pendingName = input.value;
      if (FORMATS[el.dataset.format]) pendingFormat = el.dataset.format;
      return render();
    }

    case "name-submit": {
      const input = document.querySelector("[data-name-input]");
      pendingName = (input && input.value.trim()) || `Championship ${championships.length + 1}`;
      homeView = "select";
      return render();
    }

    // In-page return to the home listing (create wizard cancel / back).
    case "goto-home":
      homeView = "home";
      return render();

    case "reset-map-order":
      clearMapOrder();
      userMapOrder = [];
      if (user) {
        setSaving(true);
        try { await saveMapOrder(user.uid, []); }
        catch (e) { console.error("reset map order failed", e); }
        finally { setSaving(false); }
      }
      return render();

    case "sign-in":
      try { await signInWithGoogle(); }       // onAuth handler re-renders on success
      catch (e) { console.error("sign-in failed", e); }
      return;

    case "sign-out":
      try { await signOutUser(); }            // onAuth handler renders sign-in screen
      catch (e) { console.error("sign-out failed", e); }
      return;

    case "new-crew":
      homeView = "new-crew";
      return render();

    case "crew-submit": {
      const input = document.querySelector("[data-crew-input]");
      const name = (input && input.value.trim()) || "My Team";
      try {
        const crew = await withLoading("Creating team…", () => createCrew(name));
        activeCrewId = crew.id;
        try { localStorage.setItem(ACTIVE_CREW_KEY, crew.id); } catch { /* ignore */ }
        await withLoading("Loading team…", async () => { await refreshCrews(); await refreshChampionships(); });
      } catch (e) { console.error("create team failed", e); }
      homeView = "home";
      return render();
    }

    case "select-crew": {
      activeCrewId = el.dataset.crew;
      editingTeamName = false;
      try { localStorage.setItem(ACTIVE_CREW_KEY, activeCrewId); } catch { /* ignore */ }
      await refreshChampionships();
      // Owner: opportunistically propagate membership to existing championships.
      const c = activeCrew();
      if (c && user && c.ownerUid === user.uid) syncCrewMembership(c.id).catch(() => {});
      return render();
    }

    case "accept-invite":
      await withLoading("Joining team…", async () => {
        try { await acceptInvite(el.dataset.crew); } catch (e) { console.error("accept failed", e); }
        activeCrewId = el.dataset.crew;
        try { localStorage.setItem(ACTIVE_CREW_KEY, activeCrewId); } catch { /* ignore */ }
        await refreshCrews();
        await refreshChampionships();
      });
      return render();

    case "invite-email": {
      const input = document.querySelector(`[data-invite-input][data-crew="${el.dataset.crew}"]`)
        || document.querySelector("[data-invite-input]");
      const email = (input && input.value.trim()) || "";
      if (!email) { flash(input); return; }
      try {
        await withLoading("Sending invite…", () => inviteEmail(el.dataset.crew, email));
        await refreshCrews();
      } catch (e) { console.error("invite failed", e); }
      return render();
    }

    case "revoke-invite":
      try {
        await withLoading("Removing invite…", () => revokeInvite(el.dataset.crew, el.dataset.email));
        await refreshCrews();
      } catch (e) { console.error("revoke failed", e); }
      return render();

    case "remove-member":
      try {
        await withLoading("Removing member…", () => removeMember(el.dataset.crew, el.dataset.uid));
        await refreshCrews();
      } catch (e) { console.error("remove member failed", e); }
      return render();

    case "leave-crew": {
      const ok = await confirmDialog({
        title: "Leave team?",
        message: "You'll lose access to this team's championships.",
        confirmLabel: "Leave",
        danger: true,
      });
      if (!ok) return;
      await withLoading("Leaving team…", async () => {
        try { await leaveCrew(el.dataset.crew); } catch (e) { console.error("leave failed", e); }
        if (activeCrewId === el.dataset.crew) activeCrewId = null;
        await refreshCrews();
        await refreshChampionships();
      });
      return render();
    }

    case "delete-crew": {
      const c = crews.find((x) => x.id === el.dataset.crew);
      const ok = await confirmDialog({
        title: `Delete ${c ? c.name : "team"}?`,
        message: "This permanently deletes the team and all of its championships for everyone. This cannot be undone.",
        confirmLabel: "Delete team",
        danger: true,
      });
      if (!ok) return;
      let delErr = null;
      await withLoading("Deleting team…", async () => {
        try {
          await deleteCrewWithChampionships(el.dataset.crew);
        } catch (e) { delErr = e; return; }
        if (activeCrewId === el.dataset.crew) {
          activeCrewId = null;
          try { localStorage.removeItem(ACTIVE_CREW_KEY); } catch { /* ignore */ }
        }
        await refreshCrews();
        await refreshChampionships();
      });
      if (delErr) {
        console.error("delete team failed", delErr);
        await alertDialog({ title: "Couldn't delete team", message: friendlyErr(delErr), danger: true });
        return render();
      }
      // If the deleted team was open as a championship, drop back to home.
      tournament = null; championshipId = null; championshipName = "";
      homeView = "home";
      return render();
    }

    case "rename-crew":
      editingTeamName = true;
      return render();

    case "cancel-rename":
      editingTeamName = false;
      return render();

    case "save-crew-name": {
      const input = document.querySelector(`[data-team-name-input][data-crew="${el.dataset.crew}"]`)
        || document.querySelector("[data-team-name-input]");
      const name = (input && input.value.trim()) || "";
      const c = crews.find((x) => x.id === el.dataset.crew);
      if (name && c && name !== c.name) {
        try {
          await withLoading("Renaming team…", () => renameCrew(el.dataset.crew, name));
          await refreshCrews();
        } catch (e) {
          console.error("rename failed", e);
          await alertDialog({ title: "Couldn't rename team", message: friendlyErr(e), danger: true });
          return render();
        }
      }
      editingTeamName = false;
      return render();
    }

    case "select-team": {
      const crew = activeCrew();
      if (!crew || !user) return;   // can only create within a team
      const state = generateTournament(el.dataset.team, pendingFormat);
      const name = (pendingName || "").trim() || `Championship ${championships.length + 1}`;
      try {
        const rec = await withLoading("Creating championship…",
          () => createChampionship(name, state, crew.id, crew.memberUids, user.uid));
        return go(urlBracket(rec.id));   // open the new championship's bracket page
      } catch (e) {
        console.error("create failed", e);
        await alertDialog({ title: "Couldn't create championship", message: friendlyErr(e), danger: true });
        homeView = "home";
        return render();
      }
    }

    case "resume":
      // The bracket page loads the championship from its ?id= on arrival.
      return go(urlBracket(el.dataset.id));

    case "delete": {
      const ok = await confirmDialog({
        title: "Delete championship?",
        message: "This permanently removes the saved championship. This cannot be undone.",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      await withLoading("Deleting championship…", async () => {
        try { await deleteChampionship(el.dataset.id); } catch (e) { console.error(e); }
        if (el.dataset.id === championshipId) {
          tournament = null;
          championshipId = null;
          championshipName = "";
        }
        await refreshChampionships();
      });
      homeView = "home";
      return render();
    }

    case "open-match":
      return go(urlMatch(championshipId, matchId));

    case "match-info":
      return go(urlMatchInfo(championshipId, matchId, parseInt(el.dataset.mapidx, 10)));

    case "dashboard": {
      const scope = el.dataset.scope === "global" ? "global" : "championship";
      return go(urlDashboard(scope, scope === "championship" ? championshipId : null));
    }

    case "import-result": {
      const idx = parseInt(el.dataset.mapidx, 10);
      const m = findMatch(tournament, matchId);
      // The user picked a specific ready-to-import candidate from the list.
      const cs = readyCsMatches.find((c) => c.id === el.dataset.csid);
      if (!cs) { await alertDialog({ title: "No result", message: "That CS result is no longer available — refresh and try again." }); return; }
      const mapped = mapCsScore(m, idx, cs);
      if (!mapped || mapped.scoreA === mapped.scoreB) {
        await alertDialog({ title: "Can't import", message: "The CS result couldn't be mapped to a clear winner. Enter the score manually." });
        return;
      }
      await update((t) => {
        const mm = findMatch(t, matchId);
        // If the user still owed a side choice for this map, adopt the real
        // starting side from the CS data so the badges match what was played.
        if (mm.veto && mm.veto.sides && !mm.veto.sides[idx]) {
          const userStart = csMyStartSide(cs);
          if (userStart) {
            const userIsA = userVetoSide(mm) === "A";
            const sideA = userIsA ? userStart : (userStart === "CT" ? "T" : "CT");
            mm.veto.sides[idx] = { sideA, sideB: sideA === "CT" ? "T" : "CT" };
          }
        }
        // Bind this map to the chosen upload so the Details view can find it.
        if (mm.veto && Array.isArray(mm.veto.mapIds) && cs.matchUuid) mm.veto.mapIds[idx] = cs.matchUuid;
        const done = recordMap(mm, mm.veto.picked[idx], mapped.scoreA, mapped.scoreB);
        if (done) { advanceWinner(t, mm); resolveAiMatches(t); }
      }, "Importing match result…");
      // Flip the source doc to IMPORTED so it stops showing as a candidate, and
      // keep the local caches in sync (drop from candidates, add for Details).
      if (cs.matchUuid) csMatchCache[cs.matchUuid] = cs;
      readyCsMatches = readyCsMatches.filter((c) => c.id !== cs.id);
      render();   // reflect the dropped candidate on any remaining next-map row
      try { await markCsMatchImported(cs.id); }
      catch (e) { console.error("mark CS imported failed", e); }
      maybeGrantChampionReward();
      return;
    }

    // Dismiss a ready-to-import candidate the user doesn't want. Non-destructive:
    // the upload is flipped to IGNORED so it stops showing as a candidate.
    case "delete-candidate": {
      const cs = readyCsMatches.find((c) => c.id === el.dataset.csid);
      if (!cs) { render(); return; }
      const ok = await confirmDialog({
        title: "Delete this result?",
        message: "This removes the upload from the import list. You won't be able to import it for any map.",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      // Drop it locally first so the list updates immediately, then persist.
      readyCsMatches = readyCsMatches.filter((c) => c.id !== cs.id);
      render();
      try { await markCsMatchIgnored(cs.id); }
      catch (e) {
        console.error("mark CS ignored failed", e);
        readyCsMatches = [cs, ...readyCsMatches];   // restore on failure
        render();
        await alertDialog({ title: "Couldn't delete", message: friendlyErr(e), danger: true });
      }
      return;
    }

    case "copy-uid": {
      const id = el.dataset.id;
      if (!id) return;
      const ok = await copyToClipboard(id);
      const original = el.textContent;
      el.textContent = ok ? "Copied!" : "Failed";
      setTimeout(() => { el.textContent = original; }, 1200);
      return;
    }

    case "save-nickname": {
      const input = document.querySelector("[data-nick-input]");
      const nick = (input && input.value.trim()) || "";
      if (!nick) { flash(input); return; }
      try {
        await withLoading("Saving nickname…", () => saveProfile(user.uid, nick));
        userNickname = nick;
      } catch (e) {
        console.error("save nickname failed", e);
        await alertDialog({ title: "Couldn't save nickname", message: friendlyErr(e), danger: true });
        return;
      }
      return render();   // clears the onboarding gate once a nickname is set
    }

    case "skip-onboarding":
      onboardingDismissed = true;
      return render();

    // Dashboard: expand/collapse a player's insight panel.
    case "toggle-player":
      expandedPlayer = expandedPlayer === el.dataset.key ? null : el.dataset.key;
      return render();

    // Dashboard: select up to two players for head-to-head comparison.
    case "toggle-compare": {
      const key = el.dataset.key;
      if (compareKeys.includes(key)) compareKeys = compareKeys.filter((k) => k !== key);
      else compareKeys = [...compareKeys, key].slice(-2);   // keep the two most recent
      return render();
    }

    case "clear-compare":
      compareKeys = [];
      return render();

    // Dashboard: switch which metric the time-series chart plots.
    case "dash-metric":
      dashboardMetric = el.dataset.metric || "rating";
      return render();

    case "start-veto":
      return update((t) => {
        const m = findMatch(t, matchId);
        if (!m.veto) m.veto = createVeto(userVetoSide(m));
        if (m.status === "pending") m.status = "live";
        // Auto-resolve any leading opponent turns so the user lands on theirs.
        autoVetoOpponent(m.veto, userVetoSide(m));
      }, "Starting map veto…");

    case "veto-pick":
      return update((t) => {
        const m = findMatch(t, matchId);
        if (m.veto && !m.veto.complete && currentAction(m.veto)?.team === userVetoSide(m)) {
          applyVeto(m.veto, el.dataset.map);
          // Then let the opponent randomly resolve up to the user's next turn.
          autoVetoOpponent(m.veto, userVetoSide(m));
        }
      }, "Processing veto…");

    case "choose-side":
      return update((t) => {
        const m = findMatch(t, matchId);
        const idx = parseInt(el.dataset.mapidx, 10);
        if (m.veto && m.veto.complete) chooseSide(m.veto, idx, el.dataset.side);
      }, "Saving side choice…");

    case "save-score": {
      const row = el.closest("[data-maprow]") || document;
      const inA = row.querySelector('input[data-score="A"]');
      const inB = row.querySelector('input[data-score="B"]');
      const scoreA = Math.max(0, parseInt(inA.value, 10) || 0);
      const scoreB = Math.max(0, parseInt(inB.value, 10) || 0);
      if (scoreA === scoreB) { flash(inA); flash(inB); return; }
      await update((t) => {
        const m = findMatch(t, matchId);
        const done = recordMap(m, el.dataset.map, scoreA, scoreB);
        if (done) {
          advanceWinner(t, m);
          // Resolve any matches that no longer involve the user (e.g. once the
          // user is eliminated the rest of the bracket plays out automatically).
          resolveAiMatches(t);
        }
      }, "Saving score…");
      maybeGrantChampionReward();   // best-effort if this completed the title
      return;
    }

    case "reset": {
      const ok = await confirmDialog({
        title: "Delete championship?",
        message: "This permanently removes the saved championship. This cannot be undone.",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      try { if (championshipId) await deleteChampionship(championshipId); } catch (e2) { console.error(e2); }
      return go(urlHome());
    }
  }
}

function flash(input) {
  if (!input) return;
  input.classList.add("ring-2", "ring-red-500");
  setTimeout(() => input.classList.remove("ring-2", "ring-red-500"), 600);
}

// Human-readable message for a Firestore error, with a hint for the common
// "rules not deployed" case.
function friendlyErr(e) {
  const msg = (e && (e.message || e.code)) ? `${e.code || ""} ${e.message || ""}`.trim() : String(e);
  if (/permission|insufficient|PERMISSION_DENIED/i.test(msg)) {
    return "The database rejected this (permission denied). The Firestore security rules may not be deployed — run `npm run deploy:rules`.";
  }
  return msg || "Unknown error.";
}


// ---- Bootstrap ------------------------------------------------------------

// Enter-key submits the focused text input by triggering its paired button.
const ENTER_SUBMITS = [
  { sel: "[data-name-input]", action: '[data-action="name-submit"]' },
  { sel: "[data-nick-input]", action: '[data-action="save-nickname"]' },
  { sel: "[data-crew-input]", action: '[data-action="crew-submit"]' },
  { sel: "[data-invite-input]", action: '[data-action="invite-email"]' },
  { sel: "[data-team-name-input]", action: '[data-action="save-crew-name"]' },
];

async function main() {
  await initDB();
  app().addEventListener("click", onClick);
  app().addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    for (const { sel, action } of ENTER_SUBMITS) {
      if (e.target.matches(sel)) {
        e.preventDefault();
        // Prefer a button scoped to the same crew (invite forms), else any.
        const crew = e.target.dataset.crew;
        const btn = (crew && document.querySelector(`${action.slice(0, -1)}][data-crew="${crew}"]`))
          || document.querySelector(action);
        if (btn) onClick({ target: btn });
        return;
      }
    }
  });

  // Gate the whole app on auth state. Fires immediately with the current user
  // (or null) and again on every sign-in/sign-out. Each page rebuilds only the
  // state it needs from the URL — there is no shared in-memory navigation.
  onAuth(async (u) => {
    user = u || null;
    if (!user) {
      crews = []; invites = []; championships = []; allChampionships = [];
      tournament = null; championshipId = null; championshipName = "";
      userNickname = ""; userMapOrder = []; profileLoaded = false; onboardingDismissed = false;
      return render();
    }
    try {
      await withLoading("Loading…", async () => {
        await loadUserProfile();
        await refreshCrews();
        await loadPageState();
      });
    } catch (err) {
      console.error("startup load failed:", err);
    }
    // Owner: propagate membership to the active team's existing championships.
    const c = activeCrew();
    if (c && c.ownerUid === user.uid) syncCrewMembership(c.id).catch(() => {});
    render();
  });
}

// Load the signed-in user's profile (CS nickname). Best-effort: a read failure
// (e.g. rules not deployed) leaves the nickname empty but doesn't block the app.
async function loadUserProfile() {
  try {
    const prof = user ? await getProfile(user.uid) : null;
    userNickname = (prof && prof.nickname) || "";
    userMapOrder = (prof && Array.isArray(prof.mapOrder)) ? prof.mapOrder : [];
    // Mirror the saved order into the localStorage cache for fast first paint.
    if (userMapOrder.length) setMapOrder(userMapOrder);
  } catch (e) {
    console.error("profile load failed", e);
    userNickname = "";
    userMapOrder = [];
  } finally {
    profileLoaded = true;
  }
}

// The user's preferred map order: their saved profile order if set, else the
// localStorage cache — always reconciled against the current map pool.
function currentMapOrder() {
  return (userMapOrder && userMapOrder.length) ? reconcileMapOrder(userMapOrder) : getMapOrder();
}

// Load the data this page needs, addressed by the URL query string.
async function loadPageState() {
  if (PAGE === "home") {
    return refreshChampionships();
  }
  if (PAGE === "bracket" || PAGE === "match" || PAGE === "info") {
    await loadChampionshipFromUrl();
    // The match / match-info pages need the uploaded CS results for that series.
    if ((PAGE === "match" || PAGE === "info") && tournament && urlMatchId) {
      await loadCsForMatch(urlMatchId);
    }
    return;
  }
  if (PAGE === "dashboard") {
    return loadDashboardState();
  }
}

// Populate csMatchCache with the uploaded CS results for one match's maps.
async function loadCsForMatch(matchId) {
  const m = findMatch(tournament, matchId);
  if (!m || !m.veto || !m.veto.complete) return;
  // Candidates the user can still import (uploaded by the plugin, status READY).
  try { readyCsMatches = await getReadyCsMatches(); }
  catch (e) { console.error("ready CS matches load failed", e); }
  // Plus the CS results already imported onto this series' maps, so the Details
  // view can render them. mapIds hold the imported results' matchUuids.
  const uuids = (m.veto.mapIds || []).filter(Boolean);
  if (uuids.length) {
    try { Object.assign(csMatchCache, await getCsMatches(uuids)); }
    catch (e) { console.error("CS match load failed", e); }
  }
}

// Load the championship named by ?id= into the active-tournament state.
async function loadChampionshipFromUrl() {
  const id = params.get("id");
  if (!id) return;
  try {
    const rec = await loadChampionship(id);
    if (!rec) return;
    championshipId = rec.id;
    championshipName = rec.name;
    tournament = rec.state;
    maybeGrantChampionReward();   // already-won championship → grant on open
  } catch (e) { console.error("championship load failed", e); }
}

// Load the data behind the dashboard (per-championship CS matches, or the
// signed-in user's all-time per-player records), surfacing read failures.
async function loadDashboardState() {
  dashboardError = null;
  dashboardLoading = true;
  try {
    if (urlScope === "championship") {
      await loadChampionshipFromUrl();
      if (tournament) Object.assign(csMatchCache, await getCsMatches(allMapUuids(tournament)));
    } else if (user) {
      csGlobalStats = await getCsPlayerMatchesByUser(user.uid);
    }
  } catch (e) {
    console.error("dashboard load failed", e);
    dashboardError = (e && (e.code || e.message)) ? `${e.code || ""} ${e.message || ""}`.trim() : "Failed to load stats.";
  } finally {
    dashboardLoading = false;
  }
}

main();
