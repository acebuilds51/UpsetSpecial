// Upset Special front door (Cloudflare Worker). See docs/cloudflare-front-door-plan.md.
//
// Phase 1: every request is passed to Apps Script unchanged. Google's Apps Script front end
// takes 1-40 s and sometimes answers with an error page, however little the request does
// (probe, 2026-09-29: typical 4.8 s, 12 of 30 over 10 s or failed). So a PURE READ is
// "hedged": if Apps Script hasn't answered in HEDGE_MS, or answered with an error page, the
// same read is sent again, and the first real answer wins. Anything that writes is sent
// exactly ONCE -- it may have run even when Google loses the answer.
//
// Phase 2: the busy reads (COPY_RULES) are answered from the Worker's own last good answer
// while it is known to be current. "Current" = no change since it was fetched: every write
// that passes through bumps a generation counter, and Apps Script sends a "stale" signal
// (action frontDoorStale + the shared secret) whenever it busts its own caches -- triggers,
// score fetches, hand edits in the Sheet, and writes from old app copies that still talk to
// Apps Script directly. Plus a max age per read as a safety net. Copies are served only when
// SERVE_COPIES = "1" and Apps Script's signal has been seen at least once.
// Apps Script stays the back office. Pointing CONFIG.API_URL back at Apps Script undoes this.

export const VERSION = 'us3';

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

// Writes that Apps Script makes safe to repeat when the app sends a requestId (phase 3):
// a repeat gets the first save's answer back and saves nothing (submitRequestKey_ in
// Code.gs). Resent ONLY after an error page / lost reply -- never just because it's slow.
export const RETRYABLE_WRITES = new Set(['submitPicks']);

export const HEDGE_MS = 7000;     // start another copy of a read after this long without an answer (probe: typical 4.8 s)
export const MAX_READ_TRIES = 3;  // at most this many copies of one read
export const READ_DEADLINE_MS = 23000;    // the app gives up at 25 s; answer (or fail) before that
export const PATIENT_DEADLINE_MS = 50000; // getTrophyRoom waits 55 s in the app

const MIN = 60 * 1000;
// Which reads are answered from copies. key(p) = the parameters that change the answer (null =
// never copy this request); maxAge = safety net; ignoreGen = not tied to the Sheet at all.
export const COPY_RULES = {
  getState:              { key: p => (p.compact ? 'getState|compact' : null), maxAge: 15 * MIN }, // same for every player
  getStandings:          { key: () => 'getStandings', maxAge: 15 * MIN },
  getBowlStandings:      { key: () => 'getBowlStandings', maxAge: 15 * MIN },
  getAllTimeLeaderboard: { key: () => 'getAllTimeLeaderboard', maxAge: 15 * MIN },
  getCareerHistory:      { key: () => 'getCareerHistory', maxAge: 15 * MIN },
  getMessages:           { key: p => 'getMessages|' + (p.type || 'general'), maxAge: 30 * 1000 },   // as Apps Script's chat cache
  getTrophyRoom:         { key: p => (p.playerId ? 'getTrophyRoom|' + p.playerId : null), maxAge: 5 * MIN },
  getAllEspnScores:      { key: () => 'getAllEspnScores', maxAge: 45 * 1000, ignoreGen: true }       // ESPN, not the Sheet
};
const MAX_COPY_CHARS = 1500 * 1000; // D1 rows hold 2 MB; anything bigger just isn't copied

const CORS = { 'access-control-allow-origin': '*' };
const MAX_BODY = 1024 * 1024;     // avatars are the largest thing the app sends (~200 KB)

// Counters since this Worker instance started (for /health; no player data). `started` is
// set on the first request: Cloudflare's clock reads 0 while the Worker is loading.
const stats = { started: 0, reads: 0, readsHedged: 0, readsSavedByRetry: 0, readsFailed: 0, writes: 0, writesFailed: 0,
  servedFromCopy: 0, copiesStored: 0, staleSignals: 0 };

export default {
  async fetch(req, env, ctx) {
    try { return await handle(req, env, ctx); }
    catch (e) { return json({ ok: false, error: 'front door: ' + e.message }, 500); }
  }
};

export async function handle(req, env, ctx) {
  if (!stats.started) stats.started = Date.now();
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...CORS, 'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' } });
  }
  const url = new URL(req.url);
  if (req.method === 'GET' && url.pathname === '/health') return json(await health(env));

  let bodyText = '', body = {}, action = url.searchParams.get('action') || '';
  if (req.method === 'POST') {
    bodyText = await req.text();
    if (bodyText.length > MAX_BODY) return json({ ok: false, error: 'Request too large' }, 413);
    try { body = JSON.parse(bodyText) || {}; action = body.action || action; } catch (e) { body = {}; /* Apps Script decides */ }
  } else if (req.method !== 'GET') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  } else {
    body = Object.fromEntries(url.searchParams);
  }

  // Apps Script: "the Sheet changed" (never passed on).
  if (action === 'frontDoorStale' && req.method === 'POST') {
    if (!env.SYNC_SECRET || !sameSecret(body.secret, env.SYNC_SECRET)) return json({ ok: false, error: 'Not allowed' }, 403);
    if (env.DB) { await bumpGen(env); await setKv(env, 'lastStale', String(Date.now())); }
    stats.staleSignals++;
    return json({ ok: true });
  }

  const target = env.APPS_SCRIPT_URL + url.search;
  const send = signal => fetch(target, req.method === 'GET'
    ? { redirect: 'follow', signal }
    : { method: 'POST', body: bodyText, headers: { 'content-type': 'text/plain' }, redirect: 'follow', signal });

  if (PURE_READS.has(action)) {
    const rule = COPY_RULES[action], key = rule && env.DB ? rule.key(body) : null;
    let genAtStart = null;
    if (key) {
      const c = await readCopy(env, key);
      genAtStart = c.gen;
      const fresh = c.json != null && Date.now() - c.storedAt < rule.maxAge && (rule.ignoreGen || c.copyGen === c.gen);
      if (fresh && env.SERVE_COPIES === '1' && c.lastStale) {
        stats.servedFromCopy++;
        return new Response(c.json, { status: 200, headers: { ...CORS, 'content-type': 'application/json', 'x-front-door': 'copy' } });
      }
    }
    const resp = PATIENT_READS.has(action) ? await hedgedRead(send, 0, PATIENT_DEADLINE_MS) : await hedgedRead(send, HEDGE_MS, READ_DEADLINE_MS);
    if (key && resp.status === 200) {
      const text = await resp.clone().text();
      let okAnswer = false; try { okAnswer = JSON.parse(text).ok === true; } catch (e) {}
      if (okAnswer && text.length <= MAX_COPY_CHARS) {
        const store = storeCopy(env, key, text, genAtStart).then(() => { stats.copiesStored++; }).catch(() => {});
        if (ctx && ctx.waitUntil) ctx.waitUntil(store); else await store;
      }
    }
    return resp;
  }

  // A write (or anything unknown): once, and whatever Google answers is passed on as-is,
  // so the app's own "refresh to check whether it went through" handling still applies.
  // Afterwards every copy is out of date -- even after a failure, since a write Google lost
  // the answer to may still have run. The bump happens BEFORE answering, so the player's
  // own next read (e.g. getState right after saving picks) goes to Apps Script.
  stats.writes++;
  let out;
  if (RETRYABLE_WRITES.has(action) && typeof body.requestId === 'string' && body.requestId) {
    out = await hedgedRead(send, 0, READ_DEADLINE_MS);
    if (out.status !== 200) stats.writesFailed++;
    if (env.DB) { try { await bumpGen(env); } catch (e) {} }
    return out;
  }
  try {
    const r = await send();
    const text = await r.text();
    if (r.ok && isJson(text)) out = new Response(text, { status: 200, headers: { ...CORS, 'content-type': 'application/json' } });
    else { stats.writesFailed++; out = new Response(text, { status: r.ok ? 502 : r.status, headers: { ...CORS, 'content-type': 'text/html' } }); }
  } catch (e) {
    stats.writesFailed++;
    out = new Response('', { status: 502, headers: CORS });
  }
  if (env.DB && action) { try { await bumpGen(env); } catch (e) {} }
  return out;
}

// ── Copies (D1) ──────────────────────────────────────────────────────────────
export async function readCopy(env, key) {
  const r = await env.DB.prepare(
    "SELECT (SELECT value FROM kv WHERE key = 'gen') AS gen, (SELECT value FROM kv WHERE key = 'lastStale') AS lastStale, " +
    'c.json AS json, c.gen AS copyGen, c.stored_at AS storedAt FROM (SELECT 1) LEFT JOIN copies c ON c.key = ?').bind(key).first();
  return { gen: Number(r && r.gen) || 0, lastStale: r && r.lastStale ? Number(r.lastStale) : 0,
    json: r ? r.json : null, copyGen: r && r.copyGen != null ? Number(r.copyGen) : -1, storedAt: r && r.storedAt ? Number(r.storedAt) : 0 };
}
async function storeCopy(env, key, text, gen) {
  // gen = the generation when this read STARTED: if anything changed while it was on its way,
  // the copy is already out of date and will never be served.
  await env.DB.prepare('INSERT INTO copies (key, json, gen, stored_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET json = excluded.json, gen = excluded.gen, stored_at = excluded.stored_at')
    .bind(key, text, gen, Date.now()).run();
}
export async function bumpGen(env) {
  await env.DB.prepare("INSERT INTO kv (key, value) VALUES ('gen', '2') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run();
}
async function setKv(env, key, value) {
  await env.DB.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}

// Public: counts and ages only, no player data.
async function health(env) {
  const out = { ok: true, version: VERSION, serveCopies: env.SERVE_COPIES === '1', ...stats };
  if (env.DB) {
    try {
      const k = await env.DB.prepare("SELECT (SELECT value FROM kv WHERE key = 'gen') AS gen, (SELECT value FROM kv WHERE key = 'lastStale') AS lastStale").first();
      const { results } = await env.DB.prepare('SELECT key, gen, stored_at FROM copies').all();
      out.gen = Number(k.gen) || 0;
      out.lastStaleSignal = k.lastStale ? Math.round((Date.now() - Number(k.lastStale)) / 60000) + ' min ago' : 'never';
      out.copies = (results || []).filter(r => !r.key.startsWith('getTrophyRoom|')).map(r => ({ key: r.key, current: Number(r.gen) === out.gen,
        age: Math.round((Date.now() - r.stored_at) / 1000) + ' s' }));
      out.trophyRoomCopies = (results || []).filter(r => r.key.startsWith('getTrophyRoom|')).length;
    } catch (e) { out.dbError = e.message; }
  }
  return out;
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
function sameSecret(a, b) {
  a = String(a || ''); b = String(b || '');
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0 && a.length > 0;
}
