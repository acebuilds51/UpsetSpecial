# Upset Special League

College football pick'em PWA. Two parts with **two completely separate deploy paths**:

| Part | File | How it goes live |
|---|---|---|
| Frontend | `index.html` (single file, no build) | Commit + push to `main` (GitHub Desktop) → GitHub Pages serves it immediately |
| Backend | `backend/Code.gs` (Google Apps Script bound to the league Google Sheet) | **Not deployed by git.** Paste into the Apps Script editor, save, then Deploy → Manage deployments → Edit (pencil) → Version: *New version* → Deploy. No clasp. |

Editing `backend/Code.gs` locally does nothing to the live app until it is pasted and redeployed.
`backend/Code.gs` in this repo is a mirror of what is in the Apps Script editor — keep them in sync.
Verify a backend deploy took effect: every API response carries `_version` (= `CODE_VERSION` in Code.gs); bump it on each backend change.

## Checks (run before every deploy; CI runs them on push)
- `node tools/check-syntax.js` — parses every inline script in index.html + Code.gs
- `node tools/backend-tests.js` — runs Code.gs under Node against in-memory fakes of SpreadsheetApp/Cache/Lock/ESPN (never touches the real sheet). Add a test for every bug fix.
- `node tools/make-frontend-harness.js` then `node tools/serve-harness.js` → http://localhost:8765/?session=1 — the real frontend against a fake backend (`window.__apiCalls` counts requests; `&fail=1` simulates outages, `&delay=ms` slowness).

## Performance rules (the Apps Script backend is the bottleneck)
- Never call `appendObject` / `updateRowByMatch` / `deleteRow` in a loop — use `appendObjects_`, `updateRowsByMatchBatch_`, `deleteRowsByMatch` (grouped) / `deleteRowsByMatchFast_`.
- Multiple HTTP calls → `UrlFetchApp.fetchAll` (`fetchEspnScoreboardRange`, `sendFcmBatch_`).
- Read-modify-write paths that can race (picks, defaults, slates) take `LockService.getScriptLock()`.
- The shared getState cache is invalidated by `handle()` after any action NOT in `READ_ONLY_ACTIONS`. New read-only endpoint → add it there.
- Frontend: all callers share one in-flight `getState` (`refreshState`); background callers pass `{shared:true}`, post-write callers use the default. Don't add new `getState` calls per render.

## League rules the code must keep
- Frozen snapshot lines are NEVER overwritten — snapshot jobs (`snapshotWeeklyLines`, `autoBackfillMissingLines`, Refresh Snapshot) only add missing games.
- Games without a frozen line are never listed or accepted as an Upset Special.
- `autoBackfillMissingLines` re-checks ESPN every 6 hours for games that gained a line.
- Login-token security is deferred by the owner — don't add it unasked.

## Diagnostics
`runDiagnostics()` (nightly trigger via `installDiagnosticsTrigger()`) writes the `DiagnosticsReport` and `DiagnosticsHistory` tabs and emails the owner on warnings. `PerfLog` tab = slow/failed requests + 5% sample.
