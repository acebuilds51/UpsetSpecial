// Upset Special front door (Cloudflare Worker). See docs/cloudflare-front-door-plan.md.
//
// Phase 1: every request is passed to Apps Script unchanged. Google's Apps Script front end
// takes 1-40 s and sometimes answers with an error page, however little the request does
// (probe, 2026-09-29: typical 4.8 s, 12 of 30 over 10 s or failed). So a PURE READ is
// "hedged": if Apps Script hasn't answered in HEDGE_MS, or answered with an error page, the
// same read is sent again, and the first real answer wins. Anything that writes is sent
// exactly ONCE -- it may have run even when Google loses the answer.
// Apps Script stays the back office. Pointing CONFIG.API_URL back at Apps Script undoes this.

export const VERSION = 'us1';

// Actions whose answer never changes anything, so sending one twice is harmless. This is
// NOT Code.gs's READ_ONLY_ACTIONS (that list means "doesn't bust the state cache" and
// includes real writes like postMessage, saveBio, submitNameClaim, adminSendCustomEmail).
// A test checks that every name here is a real action in Code.gs.
export const PURE_READS = new Set([
  'getState', 'getStandings', 'getBowlStandings', 'getAllTimeLeaderboard', 'getCareerHistory',
  'getMessages', 'getTrophyRoom', 'getAvatars', 'getAllEspnScores', 'getGameSummary',
  'getPickerSlateFromSnapshot', 'getWeeklyEspnSlate', 'searchSnapshotGames', 'searchEspnGames',
  'getMyNameClaims', 'getClaimableNames', 'getDiagnosticsSummary',
  'adminGetPending', 'adminGetNameClaims', 'adminListEmailTemplates', 'adminGetEmailTemplate',
  'adminGetResultsDraft', 'adminPreviewCustomEmail', 'adminAuditCareerHistory', 'fetchEspnGamesByDateRange'
]);

// Reads that are slow inside Apps Script itself (an AI recap, ESPN searches, the Trophy
// Room) are NOT hedged on time -- a second copy would only double the work (and the AI
// cost). They are retried only after an error page, and get the app's longer patience.
export const PATIENT_READS = new Set([
  'getTrophyRoom', 'getGameSummary', 'getWeeklyEspnSlate', 'searchEspnGames', 'searchSnapshotGames',
  'fetchEspnGamesByDateRange', 'adminAuditCareerHistory', 'adminListEmailTemplates', 'adminGetEmailTemplate'
]);

export const HEDGE_MS = 7000;     // start another copy of a read after this long without an answer (probe: typical 4.8 s)
export const MAX_READ_TRIES = 3;  // at most this many copies of one read
export const READ_DEADLINE_MS = 23000;    // the app gives up at 25 s; answer (or fail) before that
export const PATIENT_DEADLINE_MS = 50000; // getTrophyRoom waits 55 s in the app

const CORS = { 'access-control-allow-origin': '*' };
const MAX_BODY = 1024 * 1024;     // avatars are the largest thing the app sends (~200 KB)

// Counters since this Worker instance started (for /health; no player data). `started` is
// set on the first request: Cloudflare's clock reads 0 while the Worker is loading.
const stats = { started: 0, reads: 0, readsHedged: 0, readsSavedByRetry: 0, readsFailed: 0, writes: 0, writesFailed: 0 };

export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (e) { return json({ ok: false, error: 'front door: ' + e.message }, 500); }
  }
};

export async function handle(req, env) {
  if (!stats.started) stats.started = Date.now();
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...CORS, 'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' } });
  }
  const url = new URL(req.url);
  if (req.method === 'GET' && url.pathname === '/health') return json({ ok: true, version: VERSION, ...stats });

  let bodyText = '', action = url.searchParams.get('action') || '';
  if (req.method === 'POST') {
    bodyText = await req.text();
    if (bodyText.length > MAX_BODY) return json({ ok: false, error: 'Request too large' }, 413);
    try { action = JSON.parse(bodyText).action || action; } catch (e) { /* Apps Script decides */ }
  } else if (req.method !== 'GET') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  const target = env.APPS_SCRIPT_URL + url.search;
  const send = signal => fetch(target, req.method === 'GET'
    ? { redirect: 'follow', signal }
    : { method: 'POST', body: bodyText, headers: { 'content-type': 'text/plain' }, redirect: 'follow', signal });

  if (PURE_READS.has(action)) {
    return PATIENT_READS.has(action) ? hedgedRead(send, 0, PATIENT_DEADLINE_MS) : hedgedRead(send, HEDGE_MS, READ_DEADLINE_MS);
  }

  // A write (or anything unknown): once, and whatever Google answers is passed on as-is,
  // so the app's own "refresh to check whether it went through" handling still applies.
  stats.writes++;
  try {
    const r = await send();
    const text = await r.text();
    if (r.ok && isJson(text)) return new Response(text, { status: 200, headers: { ...CORS, 'content-type': 'application/json' } });
    stats.writesFailed++;
    return new Response(text, { status: r.ok ? 502 : r.status, headers: { ...CORS, 'content-type': 'text/html' } });
  } catch (e) {
    stats.writesFailed++;
    return new Response('', { status: 502, headers: CORS });
  }
}

// Sends the read, then another copy every hedgeMs (0 = never on time alone) or at once
// after an error page, up to MAX_READ_TRIES copies and deadlineMs in all. The first real
// answer wins and the others are cancelled. "No action." counts as a failure: it means
// Google lost the reply.
export async function hedgedRead(send, hedgeMs, deadlineMs) {
  stats.reads++;
  const controllers = [];
  let launched = 0, finished = 0, lastFail = { status: 502, text: '' };
  return new Promise(resolve => {
    let done = false, timer = null;
    const finish = (resp, ok) => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(deadline);
      controllers.forEach(c => { try { c.abort(); } catch (e) {} });
      if (ok && launched > 1) stats.readsSavedByRetry++;
      if (!ok) stats.readsFailed++;
      resolve(resp);
    };
    const failResponse = () => new Response(lastFail.text, { status: lastFail.status === 200 ? 502 : lastFail.status, headers: { ...CORS, 'content-type': 'text/html' } });
    const launch = () => {
      if (done || launched >= MAX_READ_TRIES) return;
      launched++;
      if (launched === 2) stats.readsHedged++;
      const c = new AbortController(); controllers.push(c);
      clearTimeout(timer);
      if (hedgeMs > 0) timer = setTimeout(launch, hedgeMs);
      send(c.signal).then(async r => {
        const text = await r.text();
        if (r.ok && isJson(text) && JSON.parse(text).error !== 'No action.') {
          finish(new Response(text, { status: 200, headers: { ...CORS, 'content-type': 'application/json' } }), true);
        } else {
          lastFail = { status: r.status, text };
          onFail();
        }
      }).catch(() => onFail());
    };
    const onFail = () => {
      finished++;
      if (done) return;
      if (launched < MAX_READ_TRIES) launch();              // an error page: try again right away
      else if (finished >= launched) finish(failResponse(), false);
    };
    const deadline = setTimeout(() => finish(failResponse(), false), deadlineMs);
    launch();
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}
function isJson(t) { try { JSON.parse(t); return true; } catch (e) { return false; } }
