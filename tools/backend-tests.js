// Regression tests for backend/Code.gs, run locally under Node against in-memory
// fakes of the Apps Script services (SpreadsheetApp, CacheService, LockService,
// UrlFetchApp/ESPN, ...). Nothing here touches the real league spreadsheet.
//
// Usage: node tools/backend-tests.js
// Exits non-zero if any test fails, so it can gate commits / CI.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------------------------------------------------------------- fakes
function makeSheet(name) {
  const data = []; // array of row arrays (1-indexed rows map to data[r-1])
  const lastRow = () => { let r = data.length; while (r > 0 && data[r - 1].every(v => v === '' || v == null)) r--; return r; };
  const lastCol = () => data.reduce((m, row) => { let c = row.length; while (c > 0 && (row[c - 1] === '' || row[c - 1] == null)) c--; return Math.max(m, c); }, 0);
  const cell = (r, c) => (data[r - 1] && data[r - 1][c - 1] !== undefined ? data[r - 1][c - 1] : '');
  const range = (r, c, nr, nc) => ({
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(r + i, c + j))),
    setValues: (vals) => {
      if (vals.length !== nr || vals.some(v => v.length !== nc)) throw new Error('setValues dimension mismatch on ' + name);
      vals.forEach((row, i) => { while (data.length < r + i) data.push([]); row.forEach((v, j) => { data[r + i - 1][c + j - 1] = v; }); });
      return range(r, c, nr, nc);
    },
    setValue: (v) => { while (data.length < r) data.push([]); data[r - 1][c - 1] = v; },
    clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (data[r + i - 1]) data[r + i - 1][c + j - 1] = ''; },
    setFontFamily: () => range(r, c, nr, nc)
  });
  const sheet = {
    _data: data,
    getName: () => name,
    getLastRow: lastRow,
    getLastColumn: lastCol,
    getMaxRows: () => Math.max(lastRow(), 1000),
    getMaxColumns: () => Math.max(lastCol(), 26),
    getRange: (r, c, nr = 1, nc = 1) => range(r, c, nr, nc),
    getDataRange: () => range(1, 1, Math.max(lastRow(), 1), Math.max(lastCol(), 1)),
    appendRow: (row) => { const r = lastRow(); data.splice(r, data.length - r); data.push(row.slice()); counters.appendRow++; },
    deleteRow: (r) => { data.splice(r - 1, 1); counters.deleteRow++; },
    deleteRows: (r, n) => {
      if (r < 2 && n >= lastRow()) throw new Error('cannot delete all rows');
      data.splice(r - 1, n); counters.deleteRows++;
    },
    setFrozenRows: () => {}, clear: () => { data.length = 0; }, setColumnWidth: () => {}
  };
  return sheet;
}
function makeSpreadsheet() {
  const sheets = {};
  return {
    _sheets: sheets,
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet(n)),
    deleteSheet: s => { delete sheets[s.getName()]; },
    getSheets: () => Object.values(sheets)
  };
}
function makeCache() {
  const m = new Map();
  return {
    _m: m,
    get: k => (m.has(k) ? m.get(k) : null),
    put: (k, v) => { if (String(v).length > 100000) throw new Error('Argument too large'); m.set(k, String(v)); },
    putAll: (o) => Object.keys(o).forEach(k => { if (String(o[k]).length > 100000) throw new Error('Argument too large'); m.set(k, String(o[k])); }),
    getAll: ks => { const o = {}; ks.forEach(k => { if (m.has(k)) o[k] = m.get(k); }); return o; },
    remove: k => m.delete(k),
    removeAll: ks => ks.forEach(k => m.delete(k))
  };
}
const counters = { appendRow: 0, deleteRow: 0, deleteRows: 0, fetch: 0, fetchAll: 0, mails: 0 };

// ESPN fake: events keyed by date; tests mutate espnEvents
let espnEvents = [];
function espnResponse() {
  return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ events: espnEvents }) };
}
function mkEvent(id, away, home, opts = {}) {
  return {
    id: String(id), date: opts.date,
    competitions: [{
      date: opts.date, startDate: opts.date,
      status: { type: { completed: !!opts.final, name: opts.final ? 'STATUS_FINAL' : 'STATUS_SCHEDULED' } },
      odds: opts.odds ? [{ details: opts.odds }] : [],
      competitors: [
        { homeAway: 'home', score: opts.homeScore != null ? String(opts.homeScore) : '', team: { displayName: home, abbreviation: home.slice(0, 3).toUpperCase(), logo: 'http://x/' + home + '.png' } },
        { homeAway: 'away', score: opts.awayScore != null ? String(opts.awayScore) : '', team: { displayName: away, abbreviation: away.slice(0, 3).toUpperCase(), logo: 'http://x/' + away + '.png' } }
      ]
    }]
  };
}

function loadBackend() {
  const ss = makeSpreadsheet();
  const cache = makeCache();
  const props = {};
  const ctx = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    CacheService: { getScriptCache: () => cache },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, tryLock: () => true, releaseLock: () => {} }) },
    Utilities: {
      getUuid: () => require('crypto').randomUUID(),
      formatDate: (d, tz, fmt) => d.toISOString().slice(0, 10).replace(/-/g, '')
    },
    Session: { getScriptTimeZone: () => 'America/New_York', getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    UrlFetchApp: {
      fetch: () => { counters.fetch++; return espnResponse(); },
      fetchAll: reqs => { counters.fetchAll++; return reqs.map(() => espnResponse()); }
    },
    MailApp: { sendEmail: () => { counters.mails++; }, getRemainingDailyQuota: () => 100 },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create: () => {} }) }), everyMinutes: () => ({ create: () => {} }) }) }), deleteTrigger: () => {} },
    Logger: { log: () => {} },
    ContentService: { createTextOutput: s => ({ _s: s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'backend', 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
  const call = (action, payload = {}) => JSON.parse(ctx.handle({ parameter: {}, postData: { contents: JSON.stringify(Object.assign({ action }, payload)) } })._s);
  return { ctx, ss, cache, props, call };
}

// ---------------------------------------------------------------- tiny test runner
const results = [];
function test(name, fn) {
  try { fn(); results.push([true, name]); }
  catch (e) { results.push([false, name, e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : String(e)]); }
}
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'mismatch') + ': expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

// ---------------------------------------------------------------- fixtures
const DAY = 86400000;
function seedLeague(env, opts = {}) {
  const { ctx, ss, call } = env;
  call('getState'); // triggers ensureSheets -> creates every tab + default season + admin p1
  const players = ss.getSheetByName('Players');
  const hdr = players._data[0];
  const addPlayer = (id, name, team) => players.appendRow(hdr.map(h => ({ id, name, teamName: team, pin: '2222', isAdmin: false, active: true, joinedSeason: 2026 })[h] ?? ''));
  addPlayer('p2', 'Pat Two', 'TEAM2');
  addPlayer('p3', 'Sam Three', 'TEAM3');

  const kickoff = new Date(Date.now() + (opts.kickoffOffset != null ? opts.kickoffOffset : 2 * DAY)).toISOString();
  const games = ss.getSheetByName('Games');
  const ghdr = games._data[0];
  for (let i = 1; i <= 10; i++) {
    games.appendRow(ghdr.map(h => ({ week: 1, gameId: 'g' + i, espnEventId: 'E' + i, awayTeam: 'Away' + i, homeTeam: 'Home' + i, favorite: 'Home' + i, spread: 3, source: 'espn', kickoff, locked: true, isFinal: false })[h] ?? ''));
  }
  const snap = ss.getSheetByName('LineSnapshot');
  const shdr = snap._data[0];
  snap.appendRow(shdr.map(h => ({ week: 1, espnEventId: 'E100', awayTeam: 'Dog U', homeTeam: 'Fav U', favorite: 'Fav U', spread: 14, kickoff })[h] ?? ''));
  // PerfectWeeks / CareerHistory aren't in HEADERS (created by hand in the real spreadsheet)
  ss.insertSheet('PerfectWeeks').appendRow(['playerId', 'teamName', 'week', 'year', 'totalGames']);
  ss.insertSheet('CareerHistory').appendRow(['playerId', 'name', 'teamName', 'year', 'points']);
  // season currentWeek = 1 (default)
  env.ctx.invalidateStateCache();
  espnEvents = [];
  for (let i = 1; i <= 10; i++) espnEvents.push(mkEvent('E' + i, 'Away' + i, 'Home' + i, { date: kickoff }));
  espnEvents.push(mkEvent('E100', 'Dog U', 'Fav U', { date: kickoff }));
  return { kickoff };
}
function picksPayload(playerId, upset) {
  const picks = [];
  for (let i = 1; i <= 10; i++) picks.push({ gameId: 'g' + i, pickedTeam: 'Home' + i, isUpset: false });
  picks.push(Object.assign({ isUpset: true }, upset));
  return { week: 1, playerId, picks };
}
const rowsOf = (env, name) => { env.ctx._sheetDataCache = {}; return env.ctx.sheetToObjects(name); };

// ---------------------------------------------------------------- tests
test('getState returns full state and is served from cache on the 2nd call', () => {
  const env = loadBackend(); seedLeague(env);
  const a = env.call('getState');
  ok(a.ok, a.error); eq(a.players.length, 3, 'players'); eq(a.games.length, 10, 'games');
  const b = env.call('getState');
  eq(b.players.length, 3); eq(b._version, a._version);
  ok(env.cache.get('appState_v3_n'), 'state cache should be populated');
});

test('state cache survives >100KB payloads via chunking', () => {
  const env = loadBackend();
  const big = 'x'.repeat(250000);
  ok(env.ctx.cachePutChunked_(env.cache, 'k', big, 60), 'put');
  eq(env.ctx.cacheGetChunked_(env.cache, 'k').length, 250000);
  env.cache.remove('k_1');
  eq(env.ctx.cacheGetChunked_(env.cache, 'k'), null, 'missing chunk must be a miss');
});

test('a write action invalidates the state cache (router-level)', () => {
  const env = loadBackend(); seedLeague(env);
  env.call('getState');
  const r = env.call('adminOverrideLine', { adminId: 'p1', gameId: 'g1', favorite: 'Away1', spread: 7 });
  ok(r.ok, r.error);
  const s = env.call('getState');
  eq(s.games.find(g => g.gameId === 'g1').favorite, 'Away1', 'override must be visible immediately');
});

test('read-only actions do NOT invalidate the state cache', () => {
  const env = loadBackend(); seedLeague(env);
  env.call('getState');
  const gen = env.cache.get('appStateGen');
  env.call('getStandings'); env.call('getMessages', { type: 'general' });
  eq(env.cache.get('appStateGen'), gen);
});

test('submitPicks writes 11 picks; resubmitting replaces instead of duplicating', () => {
  const env = loadBackend(); seedLeague(env);
  let r = env.call('submitPicks', picksPayload('p2', { espnEventId: 'E100', awayTeam: 'Dog U', homeTeam: 'Fav U', pickedTeam: 'Dog U' }));
  ok(r.ok, r.error);
  eq(rowsOf(env, 'Picks').filter(p => p.playerId === 'p2').length, 11);
  r = env.call('submitPicks', picksPayload('p2', { espnEventId: 'E100', awayTeam: 'Dog U', homeTeam: 'Fav U', pickedTeam: 'Dog U' }));
  ok(r.ok, r.error);
  const mine = rowsOf(env, 'Picks').filter(p => p.playerId === 'p2');
  eq(mine.length, 11, 'no duplicates after resubmit');
  eq(mine.filter(p => p.isUpset === true).length, 1);
  eq(rowsOf(env, 'Games').filter(g => g.source === 'external').length, 1, 'external game created once');
});

test('submitPicks leaves other players\' picks untouched', () => {
  const env = loadBackend(); seedLeague(env);
  env.call('submitPicks', picksPayload('p2', { gameId: 'g1', pickedTeam: 'Away1' }));
  env.call('submitPicks', picksPayload('p3', { gameId: 'g2', pickedTeam: 'Away2' }));
  env.call('submitPicks', picksPayload('p2', { gameId: 'g3', pickedTeam: 'Away3' }));
  const all = rowsOf(env, 'Picks');
  eq(all.filter(p => p.playerId === 'p3').length, 11);
  eq(all.filter(p => p.playerId === 'p2' && p.isUpset === true)[0].gameId, 'g3');
});

test('BUG FIX: Upset Special on the favorite of a NEW external game is rejected', () => {
  const env = loadBackend(); seedLeague(env);
  const r = env.call('submitPicks', picksPayload('p2', { espnEventId: 'E100', awayTeam: 'Dog U', homeTeam: 'Fav U', pickedTeam: 'Fav U' }));
  eq(r.ok, false); ok(/underdog/.test(r.error), r.error);
});

test('submitPicks rejects a changed pick on a locked game', () => {
  const env = loadBackend(); seedLeague(env, { kickoffOffset: -3600000 });
  const r = env.call('submitPicks', picksPayload('p2', { gameId: 'g1', pickedTeam: 'Away1' }));
  eq(r.ok, false); ok(/locked/.test(r.error), r.error);
});

test('deleteRowsByMatch removes exactly the matching rows (grouped deletes)', () => {
  const env = loadBackend(); seedLeague(env);
  const sh = env.ss.getSheetByName('Ledger');
  const hdr = sh._data[0];
  const who = ['a', 'b', 'b', 'a', 'b', 'b', 'b', 'a'];
  who.forEach((p, i) => sh.appendRow(hdr.map(h => ({ playerId: p, season: 2026, type: 't', amount: i })[h] ?? '')));
  env.ctx._sheetDataCache = {};
  env.ctx.deleteRowsByMatch('Ledger', r => r.playerId === 'b');
  eq(rowsOf(env, 'Ledger').map(r => r.amount), [0, 3, 7]);
});

test('appendObjects_ maps by the LIVE header order, not HEADERS', () => {
  const env = loadBackend(); seedLeague(env);
  const sh = env.ss.getSheetByName('BowlWinners');
  sh._data[0] = ['year', 'playerId', 'name', 'teamName', 'position', 'points']; // reordered
  env.ctx.appendObjects_('BowlWinners', [{ playerId: 'p9', name: 'N', teamName: 'T', year: 2025, position: 1, points: 10 }]);
  eq(sh._data[1], [2025, 'p9', 'N', 'T', 1, 10]);
});

test('updateRowsByMatchBatch_ updates first match per change and only dirty rows', () => {
  const env = loadBackend(); seedLeague(env);
  const n = env.ctx.updateRowsByMatchBatch_('Games', [
    { match: r => r.gameId === 'g2', updates: { spread: 9 } },
    { match: r => r.gameId === 'g5', updates: { spread: 1, bogusColumn: 'x' } }
  ]);
  eq(n, 2);
  const g = rowsOf(env, 'Games');
  eq(g.find(x => x.gameId === 'g2').spread, 9); eq(g.find(x => x.gameId === 'g5').spread, 1); eq(g.find(x => x.gameId === 'g1').spread, 3);
});

test('adminFetchResults marks games final in one pass and auto-archives a perfect week', () => {
  const env = loadBackend(); const { kickoff } = seedLeague(env);
  env.call('submitPicks', picksPayload('p2', { gameId: 'g1', pickedTeam: 'Away1' }));
  // every favorite (home) wins by 10 > spread 3, so p2 (picked all homes) is perfect
  espnEvents = [];
  for (let i = 1; i <= 10; i++) espnEvents.push(mkEvent('E' + i, 'Away' + i, 'Home' + i, { date: kickoff, final: true, homeScore: 20, awayScore: 10 }));
  const r = env.call('adminFetchResults', { adminId: 'p1', week: 1 });
  ok(r.ok, r.error);
  eq(r.updates.filter(u => u.final).length, 10);
  eq(rowsOf(env, 'Games').filter(g => g.week === 1 && g.isFinal === true).length, 10);
  const pw = rowsOf(env, 'PerfectWeeks');
  eq(pw.map(r => r.playerId), ['p2'], 'perfect week must auto-archive (was silently failing)');
  const st = env.call('getStandings');
  eq(st.standings.find(s => s.playerId === 'p2').correct, 10);
});

test('live-game auto default picks: batched, no duplicates on repeat', () => {
  const env = loadBackend(); seedLeague(env, { kickoffOffset: -3600000 });
  env.props.lastAutoScoreFetch = '0';
  env.call('getState');
  const first = rowsOf(env, 'Picks').filter(p => p.isAutoDefault === true).length;
  eq(first, 3 * 10, '3 active players x 10 kicked-off games');
  env.props.lastAutoScoreFetch = '0';
  env.call('getState');
  eq(rowsOf(env, 'Picks').filter(p => p.isAutoDefault === true).length, first, 'second run adds nothing');
});

test('ESPN date ranges are fetched in parallel (fetchAll), deduped', () => {
  const env = loadBackend();
  espnEvents = [mkEvent('1', 'A', 'B', {}), mkEvent('2', 'C', 'D', {})];
  const before = counters.fetchAll;
  const evs = env.ctx.fetchEspnScoreboardRange('20260901', '20260911');
  eq(evs.length, 2, 'same events every day must dedupe');
  eq(counters.fetchAll - before, 1, 'one fetchAll call for 11 days');
});

test('submitSlate requires the assigned picker or an admin', () => {
  const env = loadBackend(); seedLeague(env);
  const games = [{ awayTeam: 'X', homeTeam: 'Y', espnEventId: 'E100' }];
  let r = env.call('submitSlate', { week: 2, games, playerId: 'p3' });
  eq(r.ok, false);
  r = env.call('submitSlate', { week: 2, games });
  eq(r.ok, false);
  r = env.call('submitSlate', { week: 2, games, playerId: 'p1' });
  ok(r.ok, r.error);
});

test('admin name-claim endpoints now require admin (accept adminId or playerId)', () => {
  const env = loadBackend(); seedLeague(env);
  eq(env.call('adminGetNameClaims', { playerId: 'p2' }).ok, false);
  ok(env.call('adminGetNameClaims', { playerId: 'p1' }).ok);
  eq(env.call('adminReviewNameClaim', { playerId: 'p2', claimId: 'x', decision: 'approved' }).ok, false);
});

test('postMessage sends pushes in one parallel batch', () => {
  const env = loadBackend(); seedLeague(env);
  const pl = env.ss.getSheetByName('Players');
  const hdr = pl._data[0];
  pl._data.slice(1).forEach(row => { row[hdr.indexOf('fcmToken')] = 'tokA,tokB'; });
  env.props.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'proj' });
  env.cache.put('fcm_access_token', 'at');
  const before = counters.fetchAll, beforeFetch = counters.fetch;
  const r = env.call('postMessage', { playerId: 'p1', type: 'general', message: 'hello' });
  ok(r.ok, r.error);
  eq(counters.fetchAll - before, 1, 'one fetchAll'); eq(counters.fetch - beforeFetch, 0, 'no serial fetches');
  const m = env.call('getMessages', { type: 'general' });
  eq(m.messages.length, 1, 'new message visible immediately');
});

test('runDiagnostics completes and writes a report', () => {
  const env = loadBackend(); seedLeague(env);
  const rep = env.ctx.runDiagnostics();
  ok(rep.timings.length >= 7, 'timings');
  ok(rep.timings.every(t => t.ok), JSON.stringify(rep.timings.filter(t => !t.ok)));
  ok(env.ss.getSheetByName('DiagnosticsReport')._data.length > 10, 'report written');
  eq(env.ss.getSheetByName('DiagnosticsHistory')._data.length, 2);
});

test('requests no longer write a DebugLog row each', () => {
  const env = loadBackend(); seedLeague(env);
  for (let i = 0; i < 5; i++) env.call('getStandings');
  eq(env.ss.getSheetByName('DebugLog'), null);
});

// ---------------------------------------------------------------- report
let failed = 0;
results.forEach(([pass, name, err]) => {
  console.log((pass ? '  PASS  ' : '  FAIL  ') + name + (err ? '\n    ' + err : ''));
  if (!pass) failed++;
});
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);
