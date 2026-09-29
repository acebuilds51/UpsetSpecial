// The front door Worker against a fake Apps Script. Nothing here talks to Google or Cloudflare.
// Run: node --test worker/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker, { PURE_READS, PATIENT_READS, hedgedRead } from '../src/index.js';

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
