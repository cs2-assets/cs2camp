// dialog.js — Promise-based modal confirmation dialog.
//
// Replaces the browser's native confirm(), which is unreliable (browsers can
// suppress repeated native dialogs and it blocks the event loop). Rendered as
// an overlay appended to <body>, outside #app, so it doesn't interfere with the
// app's delegated click handling. Usage:
//
//   if (await confirmDialog({ title, message, confirmLabel, danger: true })) { ... }

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// The currently-open dialog, if any. Opening a new one dismisses the old.
let active = null;

export function confirmDialog(opts = {}) {
  const {
    title = "Are you sure?",
    message = "",
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    danger = false,
  } = opts;

  // Only one dialog at a time — cancel any leftover before opening.
  if (active) active.resolveCancel();

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className =
      "fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    const confirmCls = danger
      ? "bg-red-600 hover:bg-red-500 text-white"
      : "bg-accent hover:brightness-110 text-ink";

    overlay.innerHTML = `
      <div class="w-full max-w-sm bg-panel border border-slate-800 rounded-xl shadow-2xl p-5 space-y-4">
        <div class="space-y-1">
          <h2 class="text-lg font-bold">${esc(title)}</h2>
          ${message ? `<p class="text-sm text-slate-400">${esc(message)}</p>` : ""}
        </div>
        <div class="flex justify-end gap-2">
          <button data-dialog-cancel
            class="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 transition text-sm font-medium">${esc(cancelLabel)}</button>
          <button data-dialog-confirm
            class="px-4 py-2 rounded-lg ${confirmCls} transition text-sm font-bold">${esc(confirmLabel)}</button>
        </div>
      </div>`;

    const close = (result) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      if (active && active.overlay === overlay) active = null;
      resolve(result);
    };

    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
      else if (e.key === "Enter") { e.preventDefault(); close(true); }
    };

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) { close(false); return; } // backdrop cancels
      const btn = e.target.closest("button");
      if (!btn) return;
      if (btn.hasAttribute("data-dialog-confirm")) close(true);
      else if (btn.hasAttribute("data-dialog-cancel")) close(false);
    });

    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);

    active = { overlay, resolveCancel: () => close(false) };

    const confirmBtn = overlay.querySelector("[data-dialog-confirm]");
    if (confirmBtn) confirmBtn.focus();
  });
}

// Simple acknowledge-only dialog. Resolves when dismissed.
export function alertDialog(opts = {}) {
  return confirmDialog({
    title: opts.title || "Notice",
    message: opts.message || "",
    confirmLabel: opts.confirmLabel || "OK",
    cancelLabel: opts.cancelLabel || "Close",
    danger: !!opts.danger,
  });
}
