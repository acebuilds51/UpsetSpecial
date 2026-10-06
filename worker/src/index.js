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
//
// us4: (1) writes that change nothing a copy shows (a phone's failure report, the help chat,
// the recap draft) no longer drop every copy; (2) when Google fails a copied read, the last
// copy (up to STALE_IF_ERROR_MS old) is answered instead, marked `_asOf` + x-front-door:
// stale -- never to a refresh right after the player's own save (`afterWrite`); (3) career
// history has its own "history" generation, bumped only by Apps Script's scoped signal, so
// pick saves and live scores stop throwing it away; (4) per-day counts kept in D1 for /health.
// us5: chat copies are kept until something changes (max 15 min), not 30 s.

export const VERSION = 'us5';

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

// Writes that change nothing any copy shows, so they don't make the copies out of date. Each
// must be in Code.gs's READ_ONLY_ACTIONS (doesn't bust the state cache; a test checks) and
// write nowhere a copied read looks: logClientError -> PerfLog, helpChat -> nothing,
// adminGenerateResultsEmail -> the recap draft. Before this, every failure report from a
// phone dropped every copy, sending the next players to Google just as it was struggling.
export const NO_BUMP_WRITES = new Set(['logClientError', 'helpChat', 'adminGenerateResultsEmail']);

export const HEDGE_MS = 7000;     // start another copy of a read after this long without an answer (probe: typical 4.8 s)
export const MAX_READ_TRIES = 3;  // at most this many copies of one read
export const READ_DEADLINE_MS = 23000;    // the app gives up at 25 s; answer (or fail) before that
export const PATIENT_DEADLINE_MS = 50000; // getTrophyRoom waits 55 s in the app

const MIN = 60 * 1000;
// Which reads are answered from copies. key(p) = the parameters that change the answer (null =
// never copy this request); maxAge = safety net; ignoreGen = not tied to the Sheet at all;
// genKey 'hgen' = tied only to the "history" generation (past seasons change only when Apps
// Script says so: invalidateCareerHistoryCache sends frontDoorStale with scope 'history').
export const COPY_RULES = {
  getState:              { key: p => (p.compact ? 'getState|compact' : null), maxAge: 15 * MIN }, // same for every player
  getStandings:          { key: () => 'getStandings', maxAge: 15 * MIN },
  getBowlStandings:      { key: () => 'getBowlStandings', maxAge: 15 * MIN },
  getAllTimeLeaderboard: { key: () => 'getAllTimeLeaderboard', maxAge: 15 * MIN },
  getCareerHistory:      { key: () => 'getCareerHistory', maxAge: 6 * 60 * MIN, genKey: 'hgen' }, // = Apps Script's own cache
  // us5: was 30 s, so ~9 of 10 chat reads still went to Google (2026-10-05: 97 of 106). Every
  // post/delete passes through here (bumps gen), and Apps Script signals hand edits (onSheetChange).
  getMessages:           { key: p => 'getMessages|' + (p.type || 'general'), maxAge: 15 * MIN },
  getTrophyRoom:         { key: p => (p.playerId ? 'getTrophyRoom|' + p.playerId : null), maxAge: 5 * MIN },
  getAllEspnScores:      { key: () => 'getAllEspnScores', maxAge: 45 * 1000, ignoreGen: true }       // ESPN, not the Sheet
};
const MAX_COPY_CHARS = 1500 * 1000; // D1 rows hold 2 MB; anything bigger just isn't copied
// When Google fails a copied read, a copy up to this old (or the read's max age, if longer)
// is answered instead, marked with its time so the app can say "showing data from 2:14 PM".
export const STALE_IF_ERROR_MS = 30 * MIN;
const DAILY_KEEP_DAYS = 14;

// expose-headers: lets the app read x-front-door (copy / stale) for its failure reports
const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-front-door' };
const MAX_BODY = 1024 * 1024;     // avatars are the largest thing the app sends (~200 KB)

// Counters since this Worker instance started (for /health; no player data). `started` is
// set on the first request: Cloudflare's clock reads 0 while the Worker is loading.
const stats = { started: 0, reads: 0, readsHedged: 0, readsSavedByRetry: 0, readsFailed: 0, writes: 0, writesFailed: 0,
  servedFromCopy: 0, servedStale: 0, copiesStored: 0, staleSignals: 0 };

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
    // scope 'history' = past seasons changed too (invalidateCareerHistoryCache in Code.gs)
    if (env.DB) { await bumpGen(env); if (body.scope === 'history') await bumpGen(env, 'hgen'); await setKv(env, 'lastStale', String(Date.now())); }
    stats.staleSignals++;
    return json({ ok: true });
  }

  const target = env.APPS_SCRIPT_URL + url.search;
  const send = signal => fetch(target, req.method === 'GET'
    ? { redirect: 'follow', signal }
    : { method: 'POST', body: bodyText, headers: { 'content-type': 'text/plain' }, redirect: 'follow', signal });
  const tally = outcome => { if (env.DB && action) later(ctx, countDaily(env, action, outcome)); };

  if (PURE_READS.has(action)) {
    const rule = COPY_RULES[action], key = rule && env.DB ? rule.key(body) : null;
    let genAtStart = null, c = null;
    if (key) {
      c = await readCopy(env, key, rule.genKey);
      genAtStart = c.gen;
      const fresh = c.json != null && Date.now() - c.storedAt < rule.maxAge && (rule.ignoreGen || c.copyGen === c.gen);
      if (fresh && env.SERVE_COPIES === '1' && c.lastStale) {
        stats.servedFromCopy++;
        tally('copy');
        return new Response(c.json, { status: 200, headers: { ...CORS, 'content-type': 'application/json', 'x-front-door': 'copy' } });
      }
    }
    const resp = PATIENT_READS.has(action) ? await hedgedRead(send, 0, PATIENT_DEADLINE_MS) : await hedgedRead(send, HEDGE_MS, READ_DEADLINE_MS);
    if (key && resp.status === 200) {
      const text = await resp.clone().text();
      let okAnswer = false; try { okAnswer = JSON.parse(text).ok === true; } catch (e) {}
      if (okAnswer && text.length <= MAX_COPY_CHARS) {
        await later(ctx, storeCopy(env, key, text, genAtStart).then(() => { stats.copiesStored++; }).catch(() => {}));
      }
    }
    // Google failed (error pages / lost replies / the deadline): the last copy, marked with
    // its time, beats an error -- unless this refresh must show the player's own save.
    if (resp.status !== 200 && c && c.json != null && env.SERVE_COPIES === '1' && c.lastStale && !body.afterWrite &&
        Date.now() - c.storedAt < Math.max(STALE_IF_ERROR_MS, rule.maxAge)) {
      stats.servedStale++;
      tally('stale');
      return new Response(markAsOf(c.json, c.storedAt), { status: 200, headers: { ...CORS, 'content-type': 'application/json', 'x-front-door': 'stale' } });
    }
    tally(resp.status === 200 ? 'google' : 'failed');
    return resp;
  }

  // A write (or anything unknown): once, and whatever Google answers is passed on as-is,
  // so the app's own "refresh to check whether it went through" handling still applies.
  // Afterwards every copy is out of date -- even after a failure, since a write Google lost
  // the answer to may still have run. The bump happens BEFORE answering, so the player's
  // own next read (e.g. getState right after saving picks) goes to Apps Script.
  // NO_BUMP_WRITES change nothing a copy shows, so they leave the copies alone.
  stats.writes++;
  const bump = env.DB && action && !NO_BUMP_WRITES.has(action);
  let out;
  if (RETRYABLE_WRITES.has(action) && typeof body.requestId === 'string' && body.requestId) {
    out = await hedgedRead(send, 0, READ_DEADLINE_MS);
    if (out.status !== 200) stats.writesFailed++;
    if (bump) { try { await bumpGen(env); } catch (e) {} }
    tally(out.status === 200 ? 'write' : 'writeFailed');
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
  if (bump) { try { await bumpGen(env); } catch (e) {} }
  tally(out.status === 200 ? 'write' : 'writeFailed');
  return out;
}

// Off the reply path when Cloudflare allows it (ctx.waitUntil), else awaited.
function later(ctx, p) {
  if (ctx && ctx.waitUntil) ctx.waitUntil(p); else return p;
}

// '{"ok":true,...}' -> '{"_asOf":1790000000000,"_stale":1,"ok":true,...}'
export function markAsOf(jsonText, storedAt) {
  return '{"_asOf":' + Number(storedAt) + ',"_stale":1' + (jsonText.trim() === '{}' ? '}' : ',' + jsonText.trim().slice(1));
}

// ── Copies (D1) ──────────────────────────────────────────────────────────────
// genKey: which generation this copy is tied to ('gen' = anything changed, 'hgen' = history)
export async function readCopy(env, key, genKey) {
  const r = await env.DB.prepare(
    "SELECT (SELECT value FROM kv WHERE key = ?) AS gen, (SELECT value FROM kv WHERE key = 'lastStale') AS lastStale, " +
    'c.json AS json, c.gen AS copyGen, c.stored_at AS storedAt FROM (SELECT 1) LEFT JOIN copies c ON c.key = ?').bind(genKey || 'gen', key).first();
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
export async function bumpGen(env, genKey) {
  await env.DB.prepare("INSERT INTO kv (key, value) VALUES (?, '2') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").bind(genKey || 'gen').run();
}
// One row per day + action + outcome (copy / google / stale / failed / write / writeFailed).
// Counts only -- no player data. Never allowed to break a request.
async function countDaily(env, action, outcome) {
  try {
    await env.DB.prepare('INSERT INTO daily (day, action, outcome, n) VALUES (?, ?, ?, 1) ' +
      'ON CONFLICT(day, action, outcome) DO UPDATE SET n = n + 1').bind(dayKey(Date.now()), String(action).slice(0, 40), outcome).run();
  } catch (e) {}
}
function dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); } // UTC day
async function setKv(env, key, value) {
  await env.DB.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}

// Public: counts and ages only, no player data.
async function health(env) {
  const out = { ok: true, version: VERSION, serveCopies: env.SERVE_COPIES === '1', ...stats };
  if (env.DB) {
    try {
      const k = await env.DB.prepare("SELECT (SELECT value FROM kv WHERE key = 'gen') AS gen, (SELECT value FROM kv WHERE key = 'hgen') AS hgen, " +
        "(SELECT value FROM kv WHERE key = 'lastStale') AS lastStale").first();
      const { results } = await env.DB.prepare('SELECT key, gen, stored_at FROM copies').all();
      out.gen = Number(k.gen) || 0;
      out.hgen = Number(k.hgen) || 0;
      out.lastStaleSignal = k.lastStale ? Math.round((Date.now() - Number(k.lastStale)) / 60000) + ' min ago' : 'never';
      const genFor = key => { const rule = COPY_RULES[key.split('|')[0]]; return rule && rule.genKey === 'hgen' ? out.hgen : out.gen; };
      out.copies = (results || []).filter(r => !r.key.startsWith('getTrophyRoom|')).map(r => ({ key: r.key, current: Number(r.gen) === genFor(r.key),
        age: Math.round((Date.now() - r.stored_at) / 1000) + ' s' }));
      out.trophyRoomCopies = (results || []).filter(r => r.key.startsWith('getTrophyRoom|')).length;
    } catch (e) { out.dbError = e.message; }
    try { out.daily = await dailySummary(env); } catch (e) { out.dailyError = e.message; }
  }
  return out;
}

// Today and yesterday (UTC): totals per outcome, and per action. Old days are pruned here.
async function dailySummary(env) {
  const today = dayKey(Date.now()), yesterday = dayKey(Date.now() - 86400000);
  await env.DB.prepare('DELETE FROM daily WHERE day < ?').bind(dayKey(Date.now() - DAILY_KEEP_DAYS * 86400000)).run();
  const { results } = await env.DB.prepare('SELECT day, action, outcome, n FROM daily WHERE day >= ?').bind(yesterday).all();
  return [today, yesterday].map(day => {
    const totals = {}, actions = {};
    (results || []).filter(r => r.day === day).forEach(r => {
      totals[r.outcome] = (totals[r.outcome] || 0) + Number(r.n);
      (actions[r.action] = actions[r.action] || {})[r.outcome] = Number(r.n);
    });
    return { day, totals, actions };
  });
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
