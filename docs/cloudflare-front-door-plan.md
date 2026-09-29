# Upset Special: Cloudflare front door plan

*Written 2026-09-29. This follows `docs/cloudflare-front-door.md` (what was done for Ladle & Spoon)
and adapts it to Upset Special. The repo is public: no secrets or deployment URLs in this file.*

## Why

On 2026-09-29 (3:15–3:45 PM) we timed requests that do **no work at all**, once a minute for 30 rounds, using the Ladle & Spoon latency probe:

- **Upset Special:** a request with no action. The backend answers it immediately, without touching the Sheet.
- **Empty ping app:** an empty Apps Script app on the same Google account.

| Target | Typical | 1 in 10 slower than | Slowest | Google error page | Over 10 s or failed |
|---|---|---|---|---|---|
| Upset Special (no-op) | 4.8 s | 13.7 s | 39.0 s | 3 of 30 | 12 of 30 |
| Empty ping app | 4.6 s | 21.8 s | 33.0 s | 4 of 30 | 13 of 30 |

- **The wait is Google's front end.** Neither the code nor the Sheet can explain it, because the empty app was just as slow.
- **It produces exactly what players report:** "timed out after 25s", "Server returned non-JSON response", "Failed to fetch" and "No action."
- **Fixing the code can't help.** The code work of the last few weeks made the script itself fast (getState from cache is about 1.8 s), but none of it can remove this wait.

## What changes, and what doesn't

A **Cloudflare Worker** becomes the address the app talks to. **Apps Script stays the back office**:

- **Stays in Apps Script:** the Sheet, scoring, pick locks, frozen lines, emails, pushes, triggers and Jeff's hand edits all work exactly as today.
- **Moves to the Worker:** it answers the reads everyone makes all day from copies, and passes everything else through to Apps Script.

**Rollback:** change `CONFIG.API_URL` in `index.html` back to the Apps Script URL. Keep the old URL in a comment beside it.

**Cost:** Cloudflare free plan (100,000 requests a day). A normal day is a few thousand requests and a busy Saturday perhaps 20,000.

## Phase 0: setup (owner, ~15 min)

1. **Sign in:** run `npx wrangler login` in a real terminal, signed into the Cloudflare account Ladle & Spoon uses.
2. **Create the Worker and database:** Worker `upset-special-api` and D1 database `upset-special`. Put the database id in `worker/wrangler.toml` (ids aren't secret).
3. **Create the shared secret:** `npx wrangler secret put SYNC_SECRET` (a long random string). Add the same value to Apps Script Script Property `FRONT_DOOR_SECRET` and `FRONT_DOOR_URL`.
   - Use a spreadsheet menu prompt if Project Settings refuses to save; that happened on Ladle & Spoon.

## Phase 1: pass-through with retries (goal: before Saturday)

The Worker forwards every request to Apps Script unchanged. The one difference: on a **pure read** it retries up to 3 times (0.8 s, then 2 s apart) when Google answers with an error page or no JSON.

- **Pure reads** (answer never changes anything):
  - `getState`, `getStandings`, `getBowlStandings`, `getAllTimeLeaderboard`, `getCareerHistory`, `getMessages`
  - `getTrophyRoom`, `getAvatars`, `getAllEspnScores`, `getGameSummary`, `getPickerSlateFromSnapshot`, `getWeeklyEspnSlate`
  - `searchSnapshotGames`, `searchEspnGames`, `getMyNameClaims`, `getClaimableNames`, `getDiagnosticsSummary`
  - Admin reads: `adminGetPending`, `adminGetNameClaims`, `adminListEmailTemplates`, `adminGetEmailTemplate`, `adminGetResultsDraft`, `adminPreviewCustomEmail`, `adminAuditCareerHistory`, `fetchEspnGamesByDateRange`
- **Why a separate list:** do **not** reuse `READ_ONLY_ACTIONS` from Code.gs. That list means "doesn't bust the state cache", and it includes real writes (`postMessage`, `saveBio`, `submitNameClaim`, `adminSendCustomEmail`, …).
- **Everything else is sent once.** A POST may have run even when Google loses the answer. The app's existing message ("Refresh to check whether it went through") still applies.
- **`GET /health`:** version, and counts of retries and pass-throughs since start. No player data.
- **Frontend:** only `CONFIG.API_URL` changes.
- **Apps Script:** no changes. `tools/diag.js` keeps talking to Apps Script directly, so version checks stay honest.
- **Tests:** Worker unit tests with a fake Apps Script (error page → retried for reads, never for writes; body passed through byte for byte). Then point the frontend harness at a local `wrangler dev`.

**Expected effect:** most random failures on reads disappear, because a Google error page is retried inside Cloudflare within about 3 s instead of reaching the phone. The slow waits don't go away yet.

**Built and measured 2026-09-29 (Worker `us1`, `worker/`).** Same light read, once a minute for 30 rounds, 4:07–4:37 PM:

| | Typical | 1 in 10 slower than | Slowest | Google error pages | Over 10 s or failed |
|---|---|---|---|---|---|
| Through the Worker | 2.2 s | 3.3 s | 11.7 s | 0 of 30 | 1 of 30 |
| Direct to Apps Script | 2.2 s | 4.9 s | 11.2 s | 3 of 30 | 5 of 30 |

- **When Google is healthy,** the Worker adds no delay.
- **The error pages disappear:** every direct failure came back as a normal answer through the Worker.
- **The limit:** during a spell where Google's error pages themselves take about 20 s, each retry does too, and the Worker can't answer before the app's 25-second limit. Only phase 2 fixes that.

## Phase 2: answer the busy reads from copies (the speed-up)

**Freshness rule:** a copy is served only while it's known to be current. Otherwise the request passes through, and the Worker keeps the answer as the new copy.

- **The Worker sees every write from the app.** When any action outside the pure-read list succeeds, it marks the copies stale. The player's own next `getState` then goes to Apps Script and sees their saved picks. This matters: a stale copy after `submitPicks` would make a player think their picks were lost.
- **Changes that don't come through the app:** triggers (score fetches, auto-defaults, week wrap-up, snapshots) and Jeff's hand edits. Apps Script sends the Worker a small **"stale" ping** from the places it already busts its own caches (`invalidateStateCache`, `invalidatePicksBundle_`, `onSheetChange`). The ping is sent once per execution, at the end, with the shared secret.
- **Guard against a slow fetch overwriting fresh data:** a generation counter, the same pattern as `appStateGen` in Code.gs. An answer that started before a newer change isn't stored as the copy.
- **Safety net:** copies are also dropped after 15 minutes. That matches keepWarm's current safety net.

**Copies**, in order of value:

1. **`getState` with `compact: 1`.** It's the same answer for every player (shared state plus packed picks), so one copy serves everyone. Requests without `compact` (old app versions) pass through.
2. **Standings:** `getStandings`, `getBowlStandings`, `getAllTimeLeaderboard`, `getCareerHistory`.
3. **`getMessages`** per channel. `postMessage` and `deleteMessage` pass through and mark it stale.
4. **`getTrophyRoom`** per player. Stale on any change, kept at most 5 minutes (as the server does now).
5. **`getAllEspnScores`.** The Worker fetches ESPN itself with a 45-second cache, so Apps Script isn't involved at all.

- **Apps Script changes:** a `pingFrontDoor_()` helper, called where caches are busted. Add a test in `tools/backend-tests.js` that one execution sends one ping, and that nothing is sent when `FRONT_DOOR_URL` is unset. Bump `CODE_VERSION`.
- **Parity test:** for each copied action, the Worker's answer matches Apps Script's byte for byte, including `_version`, which is taken from the copy.

**As built (2026-09-29, Worker `us2`, backend `v15-front-door-sep29`):**
- **Copies are made lazily.** The Worker keeps its own last good answer to each busy read, instead of Apps Script pushing the data. Apps Script only sends the small "stale" signal (`sendFrontDoorStale_` in Code.gs).
- **Every cache bust signals.** The signal is hooked into `invalidatePicksBundle_` (which every state bust calls), the chat caches, the Trophy Room cache and the UpsetHistory summary.
  - **In a web request:** sent once, at the end of `handle()`.
  - **From triggers and hand edits:** sent straight away, after a flush.
- **Kill switch:** copies are served only with `SERVE_COPIES = "1"` in `wrangler.toml`, and only after the Worker has received Apps Script's signal at least once.
- **Tests:** 22 Worker tests and 4 backend tests cover it.

**Expected effect:** app opens, 90-second polls, tab switches and the Trophy Room answer in about 0.2 s instead of 2–40 s. That removes most of the load from Apps Script too, which also helps the writes that still go there.

## Phase 3: make pick saves safe to retry (recommended)

Picks stay **synchronous**. Apps Script still enforces the 5-minute lock, frozen lines and the underdog rule, and the screen shows "N still to pick" from its answer. What changes: the app sends a `requestId` with `submitPicks`.

- **Apps Script** remembers each `requestId`'s answer for 6 hours (CacheService) and returns it for a repeat without saving again.
- **The Worker** can then retry a pick save when Google returns an error page.

Picks are **never** queued. A queued pick delivered after kickoff would force Apps Script to trust the Worker's timestamp, which changes how locks are enforced in a real-money league.

## Phase 4 (optional): queue writes nobody waits on

- **Queue these:** `logClientError` and `markAppInstalled`. The app ignores their answers.
- **`postMessage` only with care:** the chat reloads right after posting, so the Worker would have to add the message to its copy of the channel.
- **Keep synchronous:** `registerFcmToken` (the app uses the token list it returns) and every admin action. Post week, results, ledger/payouts and the recap email all need Apps Script's answer or must keep their order.

This phase is small; do it only if phases 1–3 leave anything to gain.

## How we'll know it worked

- **Nightly diagnostics:** phone failures (`client:*`) should drop to near zero.
- **Worker `/health` counts:** copy hits vs pass-throughs, and how many retries saved a request.
- **The app's own request timings.** Note that `PerfLog` measures time inside Apps Script only, not what players wait.
- **Re-run the latency probe** against the Worker's address.

## Decisions for the owner

- Worker name, and which Cloudflare account to use.
- Phase 1 before Saturday 2026-10-03, or wait until after the weekend? It's low risk and rolls back in one line.
- Whether Phase 3's `requestId` goes in alongside Phase 2 (my recommendation) or later.
