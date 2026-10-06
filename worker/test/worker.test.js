// The front door Worker against a fake Apps Script. Nothing here talks to Google or Cloudflare.
// Run: node --test worker/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { PURE_READS, PATIENT_READS, COPY_RULES, NO_BUMP_WRITES, hedgedRead } from '../src/index.js';

const GS = 'https://script.example/exec';
const ERROR_PAGE = { status: 404, body: '<html>Sorry, unable to open the file at this time.</html>' };
const env = { APPS_SCRIPT_URL: GS };

// gs(call, n) -> { status, body } | object (sent as JSON) | Promise of either
function setup(gs) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', body: init.body || '', contentType: (init.headers || {})['content-type'] };
    calls.push(call);
    let out = await gs(call, calls.length);
    if (!(out && out.status && typeof out.body === 'string')) out = { status: 200, body: JSON.stringify(out) };
    return new Response(out.body, { status: out.status });
  };
  const post = (payload, query) => worker.fetch(new Request('https://api.example/' + (query || ''), { method: 'POST', body: JSON.stringify(payload) }), env);
  return { calls, post };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('a read is passed to Apps Script unchanged (same body, text/plain, no preflight) with CORS', async () => {
  const w = setup(() => ({ ok: true, players: [] }));
  const payload = { action: 'getState', compact: 1 };
  const r = await w.post(payload);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await r.json(), { ok: true, players: [] });
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].url, GS);
  assert.equal(w.calls[0].method, 'POST');
  assert.equal(w.calls[0].body, JSON.stringify(payload));
  assert.equal(w.calls[0].contentType, 'text/plain');
});

test('a read that gets Google\'s error page is sent again at once, and the real answer wins', async () => {
  const w = setup((c, n) => n === 1 ? ERROR_PAGE : { ok: true, standings: [1] });
  const r = await w.post({ action: 'getStandings' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, standings: [1] });
  assert.equal(w.calls.length, 2);
});

test('"No action." (Google lost the reply) is retried for a read', async () => {
  const w = setup((c, n) => n === 1 ? { ok: false, error: 'No action.' } : { ok: true, messages: [] });
  const r = await w.post({ action: 'getMessages', type: 'general' });
  assert.deepEqual(await r.json(), { ok: true, messages: [] });
  assert.equal(w.calls.length, 2);
});

test('a read that fails 3 times passes Google\'s failure on (so the app\'s own handling applies)', async () => {
  const w = setup(() => ERROR_PAGE);
  const r = await w.post({ action: 'getState', compact: 1 });
  assert.equal(r.status, 404);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(w.calls.length, 3);
});

test('a real "ok:false" answer to a read is final (not retried)', async () => {
  const w = setup(() => ({ ok: false, error: 'Player not found.' }));
  const r = await w.post({ action: 'getTrophyRoom', playerId: 'nope' });
  assert.deepEqual(await r.json(), { ok: false, error: 'Player not found.' });
  assert.equal(w.calls.length, 1);
});

test('a write is sent exactly once, even when Google answers with an error page', async () => {
  for (const action of ['submitPicks', 'postMessage', 'adminPostWeek', 'adminLedgerBatch', 'somethingNew']) {
    const w = setup(() => ERROR_PAGE);
    const r = await w.post({ action, week: 1 });
    assert.equal(r.status, 404, action);
    assert.equal(w.calls.length, 1, action + ' must never be sent twice');
  }
});

test('submitPicks WITH a requestId is resent after an error page / lost reply (Apps Script dedupes it)', async () => {
  const w = setup((c, n) => n === 1 ? ERROR_PAGE : n === 2 ? { ok: false, error: 'No action.' } : { ok: true, missing: 0 });
  const r = await w.post({ action: 'submitPicks', week: 1, picks: [], requestId: 'abc-123' });
  assert.deepEqual(await r.json(), { ok: true, missing: 0 });
  assert.equal(w.calls.length, 3);
  assert.ok(w.calls.every(c => JSON.parse(c.body).requestId === 'abc-123'), 'every copy carries the same requestId');
});

test('submitPicks WITHOUT a requestId (old app copies) is still sent exactly once', async () => {
  const w = setup(() => ERROR_PAGE);
  await w.post({ action: 'submitPicks', week: 1, picks: [] });
  assert.equal(w.calls.length, 1);
});

test('a slow submitPicks is never duplicated just for being slow', async () => {
  let n = 0;
  const w = setup(async () => { n++; await sleep(200); return { ok: true }; });
  await w.post({ action: 'submitPicks', week: 1, picks: [], requestId: 'slow-1' });
  assert.equal(n, 1);
});

test('a write\'s answer is passed through exactly, including ok:false', async () => {
  const w = setup(() => ({ ok: false, error: 'That game has already locked' }));
  const r = await w.post({ action: 'submitPicks', week: 1, picks: [] });
  assert.deepEqual(await r.json(), { ok: false, error: 'That game has already locked' });
  assert.equal(w.calls.length, 1);
});

test('a slow read gets a second copy after the hedge delay; the first answer wins', async () => {
  const calls = [];
  const send = signal => { const n = calls.push(1);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(new Response(JSON.stringify({ ok: true, from: n }))), n === 1 ? 1000 : 20);
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
    });
  };
  const t0 = Date.now();
  const r = await hedgedRead(send, 50, 2000);
  assert.deepEqual(await r.json(), { ok: true, from: 2 });
  assert.equal(calls.length, 2);
  assert.ok(Date.now() - t0 < 500, 'answered by the second copy, not after the slow first one');
});

test('hedging never sends more than 3 copies, and gives up at the deadline', async () => {
  let n = 0;
  const send = () => { n++; return new Promise(() => {}); }; // Google never answers
  const t0 = Date.now();
  const r = await hedgedRead(send, 30, 300);
  assert.equal(r.status, 502);
  assert.equal(n, 3);
  assert.ok(Date.now() - t0 >= 290);
});

test('patient reads are not hedged on time (only retried after an error page)', async () => {
  let n = 0;
  const send = () => { n++; return sleep(200).then(() => new Response(JSON.stringify({ ok: true }))); };
  const r = await hedgedRead(send, 0, 2000);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(n, 1);
});

test('GET pass-through keeps the query string; /health answers without calling Apps Script', async () => {
  const w = setup(() => ({ ok: true, summary: null }));
  const r = await worker.fetch(new Request('https://api.example/?action=getDiagnosticsSummary'), env);
  assert.deepEqual(await r.json(), { ok: true, summary: null });
  assert.equal(w.calls[0].url, GS + '?action=getDiagnosticsSummary');
  const h = await worker.fetch(new Request('https://api.example/health'), env);
  const hb = await h.json();
  assert.equal(hb.ok, true); assert.ok(hb.version);
  assert.equal(w.calls.length, 1);
});

test('CORS preflight is answered by the Worker', async () => {
  const r = await worker.fetch(new Request('https://api.example/', { method: 'OPTIONS' }), env);
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

// ── Phase 2: copies ──────────────────────────────────────────────────────────
const SCHEMA = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const SECRET = 'test-secret';
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return {
    raw: db,
    prepare(sql) {
      let args = [];
      const st = {
        bind(...a) { args = a; return st; },
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; }
      };
      return st;
    }
  };
}
// Apps Script fake with a counter per action; answers can be changed between calls.
function setup2(opts = {}) {
  const env = { APPS_SCRIPT_URL: GS, DB: fakeD1(), SYNC_SECRET: SECRET, SERVE_COPIES: opts.serve === false ? '0' : '1' };
  const hits = {}; let n = 0;
  const answers = { getState: () => ({ ok: true, v: 'state' + n }), getMessages: () => ({ ok: true, messages: ['m' + n] }),
    getTrophyRoom: b => ({ ok: true, player: b.playerId, n }), submitPicks: () => ({ ok: true, missing: 0 }), ...(opts.answers || {}) };
  globalThis.fetch = async (url, init = {}) => {
    const b = JSON.parse(init.body || '{}');
    hits[b.action] = (hits[b.action] || 0) + 1; n++;
    const out = await (answers[b.action] ? answers[b.action](b) : { ok: true });
    return new Response(JSON.stringify(out), { status: 200 });
  };
  const later = [];
  const ctx = { waitUntil: p => later.push(p) };
  const post = async payload => {
    const r = await worker.fetch(new Request('https://api.example/', { method: 'POST', body: JSON.stringify(payload) }), env, ctx);
    await Promise.all(later.splice(0));
    return r;
  };
  const stale = secret => post({ action: 'frontDoorStale', secret: secret === undefined ? SECRET : secret });
  return { env, hits, post, stale, answers };
}

test('copies: a busy read is answered from the copy once Apps Script has signalled, until something changes', async () => {
  const w = setup2();
  await w.stale();                                           // Apps Script is wired up
  const a = await w.post({ action: 'getState', compact: 1 });
  const b = await w.post({ action: 'getState', compact: 1 });
  assert.deepEqual(await b.json(), await a.json());
  assert.equal(b.headers.get('x-front-door'), 'copy');
  assert.equal(w.hits.getState, 1, 'second read never reached Apps Script');
});

test('copies: no copy is served before Apps Script\'s first stale signal, or with SERVE_COPIES off', async () => {
  let w = setup2();
  await w.post({ action: 'getState', compact: 1 }); await w.post({ action: 'getState', compact: 1 });
  assert.equal(w.hits.getState, 2, 'Apps Script not wired up yet -> always ask it');
  w = setup2({ serve: false });
  await w.stale();
  await w.post({ action: 'getState', compact: 1 }); await w.post({ action: 'getState', compact: 1 });
  assert.equal(w.hits.getState, 2, 'kill switch');
});

test('copies: a write through the Worker makes the player\'s very next read go to Apps Script (fresh picks)', async () => {
  const w = setup2();
  await w.stale();
  await w.post({ action: 'getState', compact: 1 });
  await w.post({ action: 'submitPicks', week: 1, picks: [] });
  const r = await w.post({ action: 'getState', compact: 1 });
  assert.equal(r.headers.get('x-front-door'), null);
  assert.equal(w.hits.getState, 2);
  assert.equal(w.hits.submitPicks, 1);
  await w.post({ action: 'getState', compact: 1 });
  assert.equal(w.hits.getState, 2, 'and the fresh answer becomes the new copy');
});

test('copies: Apps Script\'s stale signal (hand edits, triggers, old app copies) drops every copy; a wrong secret is refused', async () => {
  const w = setup2();
  await w.stale();
  await w.post({ action: 'getState', compact: 1 });
  const bad = await w.stale('nope');
  assert.equal(bad.status, 403);
  await w.post({ action: 'getState', compact: 1 });
  assert.equal(w.hits.getState, 1, 'wrong secret changed nothing');
  await w.stale();
  await w.post({ action: 'getState', compact: 1 });
  assert.equal(w.hits.getState, 2);
  assert.equal(w.hits.frontDoorStale, undefined, 'the signal is never passed on to Apps Script');
});

test('copies: a read that was on its way while something changed is never kept as the copy', async () => {
  let release;
  const w = setup2({ answers: { getState: () => new Promise(r => { release = () => r({ ok: true, v: 'OLD' }); }) } });
  await w.stale();
  const slow = w.post({ action: 'getState', compact: 1 });  // Apps Script reading pre-change data...
  await new Promise(r => setTimeout(r, 10));
  await w.stale();                                          // ...when the Sheet changes
  release();
  assert.deepEqual(await (await slow).json(), { ok: true, v: 'OLD' });
  w.answers.getState = () => ({ ok: true, v: 'NEW' });
  const r = await w.post({ action: 'getState', compact: 1 });
  assert.deepEqual(await r.json(), { ok: true, v: 'NEW' }, 'the OLD answer was not served as a copy');
});

test('copies: chat copies (us5) last until a post / any change, max 15 min, then go back to Apps Script', async () => {
  const w = setup2();
  await w.stale();
  await w.post({ action: 'getMessages', type: 'general' });
  await w.post({ action: 'getMessages', type: 'general' });
  assert.equal(w.hits.getMessages, 1);
  w.env.DB.raw.prepare("UPDATE copies SET stored_at = stored_at - 31000 WHERE key = 'getMessages|general'").run();
  await w.post({ action: 'getMessages', type: 'general' });
  assert.equal(w.hits.getMessages, 1, 'still current after 30 s (was the old limit)');
  await w.post({ action: 'postMessage', type: 'general', message: 'hi' });
  await w.post({ action: 'getMessages', type: 'general' });
  assert.equal(w.hits.getMessages, 2, 'a post drops the copy at once');
  w.env.DB.raw.prepare("UPDATE copies SET stored_at = stored_at - 15 * 60000 - 1000 WHERE key = 'getMessages|general'").run();
  await w.post({ action: 'getMessages', type: 'general' });
  assert.equal(w.hits.getMessages, 3, 'max age 15 min');
  await w.post({ action: 'getMessages', type: 'commissioner' });
  assert.equal(w.hits.getMessages, 4, 'each channel has its own copy');
});

test('copies: each player\'s Trophy Room is its own copy; old-app getState (not compact) and ok:false answers are never copied', async () => {
  const w = setup2({ answers: { getStandings: () => ({ ok: false, error: 'Sheet busy' }) } });
  await w.stale();
  await w.post({ action: 'getTrophyRoom', playerId: 'p1' });
  const p2 = await w.post({ action: 'getTrophyRoom', playerId: 'p2' });
  assert.equal((await p2.json()).player, 'p2');
  await w.post({ action: 'getTrophyRoom', playerId: 'p1' });
  assert.equal(w.hits.getTrophyRoom, 2);
  await w.post({ action: 'getState' }); await w.post({ action: 'getState' });
  assert.equal(w.hits.getState, 2);
  await w.post({ action: 'getStandings' }); await w.post({ action: 'getStandings' });
  assert.equal(w.hits.getStandings, 2);
});

test('copies: /health shows ages and counts only (no player data)', async () => {
  const w = setup2();
  await w.stale();
  await w.post({ action: 'getState', compact: 1 });
  await w.post({ action: 'getTrophyRoom', playerId: 'p_secret' });
  const h = await (await worker.fetch(new Request('https://api.example/health'), w.env)).json();
  assert.equal(h.serveCopies, true);
  assert.equal(h.lastStaleSignal, '0 min ago');
  assert.deepEqual(h.copies.map(c => c.key), ['getState|compact']);
  assert.equal(h.trophyRoomCopies, 1);
  assert.ok(!JSON.stringify(h).includes('p_secret'));
});

// ── us4: copies survive harmless writes, stale-if-error, history generation, daily counts ──
const LOST = () => ({ ok: false, error: 'No action.' }); // Google lost the reply (a failure for reads)

test('us4: a phone\'s failure report / help chat / recap draft leave the copies alone; a pick save still drops them', async () => {
  const w = setup2();
  await w.stale();
  await w.post({ action: 'getState', compact: 1 });
  for (const action of ['logClientError', 'helpChat', 'adminGenerateResultsEmail']) {
    await w.post({ action, failedAction: 'getState', message: 'timed out after 25s' });
    const r = await w.post({ action: 'getState', compact: 1 });
    assert.equal(r.headers.get('x-front-door'), 'copy', action + ' must not drop the copies');
  }
  assert.equal(w.hits.getState, 1);
  assert.equal(w.hits.logClientError, 1, 'the report itself still reaches Apps Script, once');
  await w.post({ action: 'submitPicks', week: 1, picks: [] });
  await w.post({ action: 'getState', compact: 1 });
  assert.equal(w.hits.getState, 2);
});

test('us4: when Google fails a copied read, the last copy is answered, marked with its time', async () => {
  const w = setup2();
  await w.stale();
  await w.post({ action: 'getState', compact: 1 });            // copy stored
  await w.stale();                                           // ...then the Sheet changed
  w.answers.getState = LOST;                                 // ...and Google is struggling
  const r = await w.post({ action: 'getState', compact: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-front-door'), 'stale');
  assert.equal(r.headers.get('access-control-expose-headers'), 'x-front-door', 'the app can read the header');
  const b = await r.json();
  assert.equal(b.ok, true); assert.equal(b._stale, 1);
  assert.ok(Math.abs(b._asOf - Date.now()) < 5000, '_asOf = when the copy was stored');
  assert.equal(w.hits.getState, 4, 'Google was really asked (3 tries) first');
  // the stale answer is not kept as a new "current" copy
  w.answers.getState = () => ({ ok: true, v: 'NEW' });
  assert.deepEqual(await (await w.post({ action: 'getState', compact: 1 })).json(), { ok: true, v: 'NEW' });
});

test('us4: no stale answer right after the player\'s own save, for too-old copies, or before Apps Script is wired up', async () => {
  let w = setup2();
  await w.stale();
  await w.post({ action: 'getState', compact: 1 });
  await w.post({ action: 'submitPicks', week: 1, picks: [] });
  w.answers.getState = LOST;
  let r = await w.post({ action: 'getState', compact: 1, afterWrite: 1 });
  assert.equal(r.status, 502, 'afterWrite: the failure is passed on, never an older board');
  r = await w.post({ action: 'getState', compact: 1 });
  assert.equal(r.headers.get('x-front-door'), 'stale', 'a background refresh does get it');
  w.env.DB.raw.prepare("UPDATE copies SET stored_at = stored_at - 31 * 60000 WHERE key = 'getState|compact'").run();
  r = await w.post({ action: 'getState', compact: 1 });
  assert.equal(r.status, 502, 'over 30 min old -> the failure');
  w = setup2();                                              // no stale signal ever seen
  await w.post({ action: 'getState', compact: 1 });
  w.answers.getState = LOST;
  assert.equal((await w.post({ action: 'getState', compact: 1 })).status, 502);
});

test('us4: career history has its own generation -- only Apps Script\'s "history" signal drops it', async () => {
  const w = setup2({ answers: { getCareerHistory: () => ({ ok: true, history: [1] }) } });
  await w.stale();
  await w.post({ action: 'getCareerHistory' });
  await w.post({ action: 'submitPicks', week: 1, picks: [] });   // a pick save
  await w.stale();                                                // live scores / any other bust
  let r = await w.post({ action: 'getCareerHistory' });
  assert.equal(r.headers.get('x-front-door'), 'copy');
  assert.equal(w.hits.getCareerHistory, 1);
  await w.post({ action: 'frontDoorStale', secret: SECRET, scope: 'history' });
  r = await w.post({ action: 'getCareerHistory' });
  assert.equal(r.headers.get('x-front-door'), null);
  assert.equal(w.hits.getCareerHistory, 2);
  const h = await (await worker.fetch(new Request('https://api.example/health'), w.env)).json();
  assert.equal(h.copies.find(c => c.key === 'getCareerHistory').current, true, '/health judges it by the history generation');
  await w.post({ action: 'getState', compact: 1 });
  await w.post({ action: 'frontDoorStale', secret: SECRET, scope: 'history' });
  await w.post({ action: 'getState', compact: 1 });
  assert.equal(w.hits.getState, 2, 'the history signal also drops the ordinary copies');
});

test('us4: /health keeps per-day counts by action and outcome (no player data)', async () => {
  const w = setup2();
  await w.stale();
  await w.post({ action: 'getState', compact: 1 });            // google
  await w.post({ action: 'getState', compact: 1 });            // copy
  await w.post({ action: 'submitPicks', week: 1, picks: [], playerId: 'p_secret' }); // write
  w.answers.getStandings = LOST;
  await w.post({ action: 'getStandings' });                    // failed (no copy yet)
  const h = await (await worker.fetch(new Request('https://api.example/health'), w.env)).json();
  const today = h.daily[0];
  assert.equal(today.day, new Date().toISOString().slice(0, 10));
  assert.deepEqual(today.actions.getState, { google: 1, copy: 1 });
  assert.deepEqual(today.actions.submitPicks, { write: 1 });
  assert.deepEqual(today.actions.getStandings, { failed: 1 });
  assert.equal(today.totals.copy, 1);
  assert.ok(!JSON.stringify(h).includes('p_secret'));
});

test('us4: every NO_BUMP write is in Code.gs READ_ONLY_ACTIONS and is not a pure read', () => {
  const code = fs.readFileSync(new URL('../../backend/Code.gs', import.meta.url), 'utf8');
  const block = code.match(/var READ_ONLY_ACTIONS = \{([\s\S]*?)\};/)[1];
  const readOnly = new Set([...block.matchAll(/([A-Za-z]+)\s*:\s*1/g)].map(m => m[1]));
  for (const a of NO_BUMP_WRITES) {
    assert.ok(readOnly.has(a), a + ' busts the state cache in Code.gs, so it must drop the copies');
    assert.ok(!PURE_READS.has(a), a);
  }
});

test('every copied read is a pure read', () => {
  for (const a of Object.keys(COPY_RULES)) assert.ok(PURE_READS.has(a), a);
});

test('every PURE_READ / PATIENT_READ is a real action in Code.gs, and no known write is on the list', () => {
  const code = fs.readFileSync(new URL('../../backend/Code.gs', import.meta.url), 'utf8');
  const actions = new Set([...code.matchAll(/case '([A-Za-z]+)':/g)].map(m => m[1]));
  for (const a of PURE_READS) assert.ok(actions.has(a), a + ' is not an action in Code.gs');
  for (const a of PATIENT_READS) assert.ok(PURE_READS.has(a), a + ' is patient but not a pure read');
  const writes = ['submitPicks', 'postMessage', 'deleteMessage', 'saveBio', 'generateBio', 'helpChat', 'submitNameClaim',
    'registerFcmToken', 'markAppInstalled', 'logClientError', 'changePin', 'updateProfile', 'submitSlate',
    'adminSendCustomEmail', 'adminSendTemplateEmail', 'adminGenerateResultsEmail', 'adminLedgerBatch', 'adminPostWeek'];
  for (const a of writes) assert.ok(!PURE_READS.has(a), a + ' writes (or costs money) and must never be sent twice');
});
