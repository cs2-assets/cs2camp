// prefs.js — Persisted, user-local preferences (localStorage).
//
// Currently holds the map preference order: the maps ranked most → least
// preferred by the user's team, set via drag-and-drop on the home screen and
// used to order the user's veto pick/ban options.

import { MAP_POOL } from "./teams.js";

const MAP_ORDER_KEY = "cs2.mapOrder";

// Reconcile a saved order with the current pool: drop stale maps and append any
// newly-added maps at the end, so a changed MAP_POOL never breaks a saved order.
export function reconcileMapOrder(saved) {
  const arr = Array.isArray(saved) ? saved : [];
  const ranked = arr.filter((m) => MAP_POOL.includes(m));
  const rest = MAP_POOL.filter((m) => !ranked.includes(m));
  return [...ranked, ...rest];
}

// The map pool in the user's preferred order, from the localStorage cache.
export function getMapOrder() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(MAP_ORDER_KEY)) || []; } catch { saved = []; }
  return reconcileMapOrder(saved);
}

export function setMapOrder(order) {
  try { localStorage.setItem(MAP_ORDER_KEY, JSON.stringify(order)); } catch { /* ignore */ }
}

export function clearMapOrder() {
  try { localStorage.removeItem(MAP_ORDER_KEY); } catch { /* ignore */ }
}
