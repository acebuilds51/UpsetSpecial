# Upset Special League

College football pick'em PWA. Two parts with **two completely separate deploy paths**:

| Part | File | How it goes live |
|---|---|---|
| Frontend | `index.html` (single file, no build) | Commit + push to `main` (GitHub Desktop) → GitHub Pages serves it immediately |
| Backend | `backend/Code.gs` + `backend/Notifications.gs` (Google Apps Script bound to the league Google Sheet) | **Not deployed by git.** Paste each file into the same-named file in the Apps Script editor, save, then Deploy → Manage deployments → Edit (pencil) → Version: *New version* → Deploy. No clasp. |

Editing `backend/*.gs` locally does nothing to the live app until it is pasted and redeployed.
The `.gs` files here mirror the Apps Script project — keep them in sync. All files share ONE global
namespace: a function name defined in two files silently overrides (a test fails on duplicates).
The Apps Script project also holds one-time migration/test files that are deliberately NOT in this
public repo (they contain player names / Drive IDs). Never put credentials in `.gs` files — use
Script Properties (e.g. `FCM_SERVICE_ACCOUNT_JSON`).
Verify a backend deploy took effect: every API response carries `_version` (= `CODE_VERSION` in Code.gs); bump it on each backend change.

## Helper scripts (pre-approved as `node tools/*` for automated sessions)
- `node tools/git.js <args>` — GitHub Desktop's git (git isn't on PATH); refuses `push`.
- `node tools/wt.js <YYYY-MM-DD> <script.js>` — run a tools/ script inside the weekly worktree `../UpsetSpecial-weekly-<date>`.
- `node tools/diag.js` — read-only fetch of the live nightly diagnostics summary (no player names).

## Checks (run before every deploy; CI runs them on push)
- `node tools/check-syntax.js` — parses every inline script in index.html + Code.gs, and fails on any `<button id=…>` / button `data-*` attribute that no code looks up (a dead button)
- `node tools/backend-tests.js` — runs Code.gs under Node against in-memory fakes of SpreadsheetApp/Cache/Lock/ESPN (never touches the real sheet). Add a test for every bug fix.
- `node tools/make-frontend-harness.js` then `node tools/serve-harness.js` → http://localhost:8765/?session=1 — the real frontend against a fake backend (`window.__apiCalls` counts requests; `&fail=1` simulates outages, `&delay=ms` slowness, `&final=1` a finished week with a tie + perfect weeks, `&unposted=1` an unposted board with missing fields).

## Performance rules (the Apps Script backend is the bottleneck)
- Never call `appendObject` / `updateRowByMatch` / `deleteRow` in a loop — use `appendObjects_`, `updateRowsByMatchBatch_`, `deleteRowsByMatch` (grouped) / `deleteRowsByMatchFast_`.
- Multiple HTTP calls → `UrlFetchApp.fetchAll` (`fetchEspnScoreboardRange`, `sendFcmBatch_`).
- Read-modify-write paths that can race (picks, defaults, slates) take `LockService.getScriptLock()`.
- The shared getState cache is invalidated by `handle()` after any action NOT in `READ_ONLY_ACTIONS`. New read-only endpoint → add it there.
- Script writes that bypass `handle()` (time triggers, editor-run fixes) must call `invalidateStateCache()` / `invalidateCareerHistoryCache()` themselves. Once `installSheetChangeTrigger()` has run, keepWarm only rebuilds the state when it was busted or is >15 min old, and CareerHistory is cached 6h.
- Keep web-app replies FAST as well as small: a run of ~15s+ also makes Google lose the reply (the app sees `No action.` or a Drive "Page Not Found" page). getState's picks/ledger/bowlPicks are cached (`getPicksBundle_`), busted by every helper write to those tabs (`invalidateSheetCache` / `appendObject`) and re-busted after flush (`releaseLock_`, end of `handle()`). Raw `sheet.getRange().setValues()` writes to Picks/Ledger/BowlPicks must call `invalidatePicksBundle_()`.
- The Trophy Room reads a cached per-team summary of UpsetHistory (`getUpsetHistoryIndex_`, up to 6h). Any script write to UpsetHistory must flush and then call `invalidateSheetCache('UpsetHistory')` (as `updateUpsetHistoryForWeek` does); after editor-run fixes, run `clearCareerCache()`.
- Keep web-app replies small: Google's web-app layer drops large replies (getState at ~440KB came back as `No action.`). getState sends picks packed (`compactPicks_` ↔ `unpackPicks()` in index.html) when the app asks with `compact: 1`; the plain form remains for old cached app versions. Don't add bulky fields to getState.
- Frontend: all callers share one in-flight `getState` (`refreshState`); background callers pass `{shared:true}`, post-write callers use the default. Don't add new `getState` calls per render.

## League rules the code must keep
- Frozen snapshot lines are NEVER overwritten — snapshot jobs (`snapshotWeeklyLines`, `autoBackfillMissingLines`, Refresh Snapshot) only add missing games.
- Games without a frozen line are never listed or accepted as an Upset Special.
- `autoBackfillMissingLines` re-checks ESPN every 6 hours for games that gained a line.
- Login-token security is deferred by the owner — don't add it unasked.
- Only the weekly high score is paid each week (split on ties). There is NO perfect-week (10/10) cash bonus any more; perfect weeks are trophies only. Old `perfect_bonus` ledger rows stay as history.

## Diagnostics
`runDiagnostics()` (nightly trigger via `installDiagnosticsTrigger()`) writes the `DiagnosticsReport` and `DiagnosticsHistory` tabs and emails the owner on warnings. `PerfLog` tab = slow/failed requests + 5% sample.
