// loading.js — Lightweight loading feedback for async data operations.
//
// Two affordances, both rendered outside #app (appended to <body>) so the app's
// re-render never wipes them:
//   - withLoading(message, fn): a blocking, centered spinner overlay shown while
//     fn runs. Use for user-initiated operations (load, create, delete).
//   - setSaving(on): a small non-blocking "Saving…" pill in the corner, used for
//     background persistence after each action.
//
// Both delay their appearance briefly so fast, sub-perceptible operations don't
// flash a spinner.

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function spinner(size = "h-5 w-5") {
  return `<div class="${size} rounded-full border-2 border-slate-600 border-t-accent animate-spin" role="status" aria-label="Loading"></div>`;
}

// ---- Blocking overlay -----------------------------------------------------

let overlay = null;

function showOverlay(message) {
  if (overlay) {
    const msg = overlay.querySelector("[data-msg]");
    if (msg) msg.textContent = message;
    return;
  }
  overlay = document.createElement("div");
  overlay.className =
    "fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm";
  overlay.setAttribute("role", "status");
  overlay.setAttribute("aria-live", "polite");
  overlay.innerHTML = `
    <div class="flex items-center gap-3 bg-panel border border-slate-800 rounded-xl shadow-2xl px-5 py-4">
      ${spinner()}
      <span data-msg class="text-sm font-medium">${esc(message)}</span>
    </div>`;
  document.body.appendChild(overlay);
}

function hideOverlay() {
  if (overlay) { overlay.remove(); overlay = null; }
}

// Run `fn` while showing a blocking spinner overlay. The overlay only appears if
// `fn` takes longer than `delay` ms, avoiding a flash on fast operations.
export async function withLoading(message, fn, delay = 150) {
  let shown = false;
  const timer = setTimeout(() => { shown = true; showOverlay(message); }, delay);
  try {
    return await fn();
  } finally {
    clearTimeout(timer);
    if (shown) hideOverlay();
  }
}

// ---- Background "Saving…" pill --------------------------------------------

let saveTimer = null;
let savePill = null;

export function setSaving(on) {
  if (on) {
    if (saveTimer || savePill) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      savePill = document.createElement("div");
      savePill.className =
        "fixed bottom-4 right-4 z-40 flex items-center gap-2 bg-panel/95 border border-slate-800 rounded-full shadow-lg px-3 py-1.5";
      savePill.setAttribute("role", "status");
      savePill.setAttribute("aria-live", "polite");
      savePill.innerHTML = `${spinner("h-3.5 w-3.5")}<span class="text-xs text-slate-300">Saving…</span>`;
      document.body.appendChild(savePill);
    }, 250);
  } else {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (savePill) { savePill.remove(); savePill = null; }
  }
}
