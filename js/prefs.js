// prefs.js — Persisted, user-local preferences (localStorage).
//
// Currently holds the map preference order: the maps ranked most → least
// preferred by the user's team, set via drag-and-drop on the home screen and
// used to order the user's veto pick/ban options.

import { MAP_POOL } from "./teams.js";

const MAP_ORDER_KEY = "cs2.mapOrder";

// The map pool in the user's preferred order. Reconciled with the current pool:
// stale maps are dropped and any newly-added maps are appended at the end, so a
// changed MAP_POOL never breaks the saved preference.
export function getMapOrder() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(MAP_ORDER_KEY)) || []; } catch { saved = []; }
  const ranked = saved.filter((m) => MAP_POOL.includes(m));
  const rest = MAP_POOL.filter((m) => !ranked.includes(m));
  return [...ranked, ...rest];
}

export function setMapOrder(order) {
  try { localStorage.setItem(MAP_ORDER_KEY, JSON.stringify(order)); } catch { /* ignore */ }
}

export function clearMapOrder() {
  try { localStorage.removeItem(MAP_ORDER_KEY); } catch { /* ignore */ }
}
