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
const sentRequests = []; // every request passed to UrlFetchApp.fetchAll (pushes included)
const pushes = () => sentRequests.filter(r => String(r.url).indexOf('fcm.googleapis.com') >= 0).map(r => JSON.parse(r.payload).message);

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
  const triggers = [];
  sentRequests.length = 0;
  const ctx = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush: () => {} },
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
      fetchAll: reqs => { counters.fetchAll++; sentRequests.push(...reqs); return reqs.map(() => espnResponse()); }
    },
    MailApp: { sendEmail: () => { counters.mails++; }, getRemainingDailyQuota: () => 100 },
    ScriptApp: (() => {
      const chain = { create() { triggers.push({ getHandlerFunction: () => chain._fn }); return chain; } };
      ['timeBased', 'everyDays', 'atHour', 'everyMinutes', 'everyHours', 'onWeekDay', 'at', 'forSpreadsheet', 'onChange'].forEach(m => { chain[m] = () => chain; });
      return {
        WeekDay: { MONDAY: 'MONDAY', SUNDAY: 'SUNDAY' },
        getProjectTriggers: () => triggers.slice(),
        newTrigger: fn => { chain._fn = fn; return chain; },
        deleteTrigger: t => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); }
      };
    })(),
    Logger: { log: () => {} },
    ContentService: { createTextOutput: s => ({ _s: s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } }
  };
  vm.createContext(ctx);
  // Apps Script shares one global scope across every file in the project -- load them all
  const dir = path.join(__dirname, '..', 'backend');
  ['Code.gs'].concat(fs.readdirSync(dir).filter(f => f.endsWith('.gs') && f !== 'Code.gs').sort()).forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  });
  const call = (action, payload = {}) => JSON.parse(ctx.handle({ parameter: {}, postData: { contents: JSON.stringify(Object.assign({ action }, payload)) } })._s);
  return { ctx, ss, cache, props, call, triggers };
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

test('Upset Special on a game with NO frozen line is rejected (no client-supplied spreads)', () => {
  const env = loadBackend(); const { kickoff } = seedLeague(env);
  espnEvents.push(mkEvent('E999', 'Nobody', 'Someone', { date: kickoff }));
  const r = env.call('submitPicks', picksPayload('p2', { espnEventId: 'E999', awayTeam: 'Nobody', homeTeam: 'Someone', pickedTeam: 'Nobody', favorite: 'Someone', spread: 40 }));
  eq(r.ok, false); ok(/frozen line/.test(r.error), r.error);
  eq(rowsOf(env, 'Games').filter(g => g.source === 'external').length, 0, 'no game row created');
});

test('REGRESSION (Uncle D, wk4): can change a later game after his board-game Upset Special kicked off', () => {
  const env = loadBackend(); seedLeague(env);
  // g1 = his Upset Special AND straight pick (same team, board mode), later games still open
  const upset = { gameId: 'g1', pickedTeam: 'Away1' };
  const first = picksPayload('p2', upset);
  first.picks[0].pickedTeam = 'Away1';
  let r = env.call('submitPicks', first);
  ok(r.ok, r.error);
  // g1 kicks off (noon); g9 still hours away
  const gs = env.ss.getSheetByName('Games'); const h = gs._data[0];
  gs._data.forEach((row, i) => { if (i && row[h.indexOf('gameId')] === 'g1') row[h.indexOf('kickoff')] = new Date(Date.now() - 3600000).toISOString(); });
  env.ctx.invalidateStateCache();
  const second = picksPayload('p2', upset);
  second.picks[0].pickedTeam = 'Away1';
  second.picks[8].pickedTeam = 'Away9'; // the "Alabama -> South Carolina" change
  r = env.call('submitPicks', second);
  ok(r.ok, 'change should be accepted: ' + r.error);
  eq(rowsOf(env, 'Picks').find(p => p.playerId === 'p2' && p.gameId === 'g9' && p.isUpset !== true).pickedTeam, 'Away9');
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

test('REGRESSION (wk4): automatic score updates also finalize Upset Special games outside the board', () => {
  const env = loadBackend(); const { kickoff } = seedLeague(env);
  env.call('submitPicks', picksPayload('p2', { espnEventId: 'E100', awayTeam: 'Dog U', homeTeam: 'Fav U', pickedTeam: 'Dog U' }));
  // everything kicks off and ends; only the automatic path runs (no admin Fetch Results)
  const past = new Date(Date.now() - 5 * 3600000).toISOString();
  const gs = env.ss.getSheetByName('Games'); const h = gs._data[0];
  gs._data.forEach((row, i) => { if (i) row[h.indexOf('kickoff')] = past; });
  espnEvents = [];
  for (let i = 1; i <= 10; i++) espnEvents.push(mkEvent('E' + i, 'Away' + i, 'Home' + i, { date: past, final: true, homeScore: 30, awayScore: 20 }));
  espnEvents.push(mkEvent('E100', 'Dog U', 'Fav U', { date: past, final: true, homeScore: 10, awayScore: 24 }));
  env.props.lastAutoScoreFetch = '0';
  env.ctx.invalidateStateCache();
  env.call('getState');
  const ext = rowsOf(env, 'Games').find(g => g.source === 'external');
  eq(ext.isFinal, true, 'external Upset Special game must be scored automatically');
  eq(env.call('getStandings').standings.find(s => s.playerId === 'p2').upsetWins, 1);
  eq(rowsOf(env, 'Picks').filter(p => p.isAutoDefault === true && p.gameId === ext.gameId).length, 0, 'never auto-default an external game');
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

test('re-running the snapshot never overwrites a frozen line, only adds new games', () => {
  const env = loadBackend(); const { kickoff } = seedLeague(env);
  // ESPN now shows E100 at a DIFFERENT line, plus a brand-new game E200
  espnEvents = [
    mkEvent('E100', 'Dog U', 'Fav U', { date: kickoff, odds: 'FAV -3' }),
    mkEvent('E200', 'New A', 'New B', { date: kickoff, odds: 'NEW -7' })
  ];
  env.ctx._sheetDataCache = {};
  const added = env.ctx.snapshotWeeklyLines(1);
  eq(added, 1, 'only the new game is added');
  const snap = rowsOf(env, 'LineSnapshot').filter(r => r.week === 1);
  const e100 = snap.filter(r => String(r.espnEventId) === 'E100');
  eq(e100.length, 1, 'no duplicate row for the frozen game');
  eq(e100[0].spread, 14, 'frozen spread untouched');
  eq(e100[0].favorite, 'Fav U', 'frozen favorite untouched');
  ok(snap.some(r => String(r.espnEventId) === 'E200'), 'new game captured');
});

// ---------------------------------------------------------------- Notifications.gs
function enablePush(env) {
  const pl = env.ss.getSheetByName('Players');
  const hdr = pl._data[0];
  pl._data.slice(1).forEach((row, i) => { row[hdr.indexOf('fcmToken')] = 'tok' + i + 'a,tok' + i + 'b'; });
  env.props.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'proj' });
  env.cache.put('fcm_access_token', 'at');
}
// home (favorite, -3) wins by `margin`; E100 external upset: Dog U beats Fav U
function finishWeek(env, kickoff, margin) {
  espnEvents = [];
  for (let i = 1; i <= 10; i++) espnEvents.push(mkEvent('E' + i, 'Away' + i, 'Home' + i, { date: kickoff, final: true, homeScore: 20 + margin, awayScore: 20 }));
  espnEvents.push(mkEvent('E100', 'Dog U', 'Fav U', { date: kickoff, final: true, homeScore: 10, awayScore: 24 }));
  const r = env.call('adminFetchResults', { adminId: 'p1', week: 1 });
  ok(r.ok, r.error);
}

test('week-final job scores straight picks AGAINST THE SPREAD and counts external Upset Specials', () => {
  const env = loadBackend(); const { kickoff } = seedLeague(env); enablePush(env);
  env.call('submitPicks', picksPayload('p2', { espnEventId: 'E100', awayTeam: 'Dog U', homeTeam: 'Fav U', pickedTeam: 'Dog U' }));
  finishWeek(env, kickoff, 2); // favorites win by 2 but the spread is 3 -> underdogs cover
  env.ctx._sheetDataCache = {};
  env.ctx.checkGameFinalNotifications();
  const uh = rowsOf(env, 'UpsetHistory').find(r => r.teamName === 'TEAM2');
  eq(uh.correctCount, 0, 'picked all favorites, none covered');
  eq(uh.hit, true, 'external Upset Special counted');
  eq(uh.upsetPts, 14); eq(uh.weekPts, 14);
  const st = env.call('getStandings').standings.find(s => s.playerId === 'p2');
  eq(st.points, uh.weekPts, 'UpsetHistory must match the standings');
  const finals = pushes().filter(m => /Final/.test(m.notification.title));
  eq(finals.length, 10 * 3 * 2, '10 games x 3 players x 2 devices, each token separately');
  ok(/Away1 covered — 0\/1 players correct/.test(finals[0].notification.body), finals[0].notification.body);
});

test('week-final job notifies each game once and does nothing when nothing is new', () => {
  const env = loadBackend(); const { kickoff } = seedLeague(env); enablePush(env);
  finishWeek(env, kickoff, 10);
  env.ctx._sheetDataCache = {};
  env.ctx.checkGameFinalNotifications();
  const n = pushes().length;
  ok(n > 0);
  env.ctx._sheetDataCache = {};
  env.ctx.checkGameFinalNotifications();
  eq(pushes().length, n, 'second run sends nothing');
});

test('perfect weeks are recorded exactly once (Fetch Results + week-final job)', () => {
  const env = loadBackend(); const { kickoff } = seedLeague(env);
  env.call('submitPicks', picksPayload('p2', { gameId: 'g1', pickedTeam: 'Away1' }));
  finishWeek(env, kickoff, 10); // favorites cover -> p2 perfect
  env.ctx._sheetDataCache = {};
  env.ctx.checkGameFinalNotifications();
  eq(rowsOf(env, 'PerfectWeeks').filter(r => r.playerId === 'p2').length, 1);
  eq(rowsOf(env, 'UpsetHistory').find(r => r.teamName === 'TEAM2').isPerfect, true);
});

test('season archive writes exactly the standings totals to CareerHistory', () => {
  const env = loadBackend(); const { kickoff } = seedLeague(env);
  env.call('submitPicks', picksPayload('p2', { espnEventId: 'E100', awayTeam: 'Dog U', homeTeam: 'Fav U', pickedTeam: 'Dog U' }));
  finishWeek(env, kickoff, 10);
  env.ctx._sheetDataCache = {};
  env.ctx.updateCareerHistoryForSeason(2026);
  const ch = rowsOf(env, 'CareerHistory').filter(r => r.year === 2026);
  const st = env.call('getStandings').standings;
  eq(ch.find(r => r.playerId === 'p2').points, st.find(s => s.playerId === 'p2').points);
  eq(ch.find(r => r.playerId === 'p2').points, 10 + 14);
});

test('season is never auto-finalized during the season (Sep-Dec)', () => {
  const env = loadBackend(); const { kickoff } = seedLeague(env);
  finishWeek(env, kickoff, 10);
  env.ctx._sheetDataCache = {};
  const realDate = env.ctx.Date;
  env.ctx.autoFinalizeSeasonIfComplete(); // test runs "today" -- guard only matters Aug-Jan 19
  const month = new Date().getMonth() + 1;
  if (month >= 8 || (month === 1 && new Date().getDate() < 20)) eq(env.props['season_finalized_2026'], undefined);
});

test('repairThisSeasonHistory rebuilds weeks and flags (not deletes) bad perfect weeks', () => {
  const env = loadBackend(); const { kickoff } = seedLeague(env);
  env.call('submitPicks', picksPayload('p2', { gameId: 'g1', pickedTeam: 'Away1' }));
  finishWeek(env, kickoff, 2); // favorites don't cover -> p2 NOT perfect ATS
  const pw = env.ss.getSheetByName('PerfectWeeks'); // simulate a v1 (outright-winner) row
  pw.appendRow(['p2', 'TEAM2', 1, 2026, 10]);
  env.ctx._sheetDataCache = {};
  env.ctx.repairThisSeasonHistory();
  eq(rowsOf(env, 'UpsetHistory').find(r => r.teamName === 'TEAM2').correctCount, 0);
  eq(rowsOf(env, 'PerfectWeeks').length, 1, 'suspect row is listed, never deleted');
});

test('retired checkPickReminders removes its own trigger instead of sending', () => {
  const env = loadBackend(); seedLeague(env); enablePush(env);
  env.ctx.ScriptApp.newTrigger('checkPickReminders').timeBased().everyMinutes(15).create();
  const before = pushes().length;
  env.ctx.checkPickReminders();
  eq(env.triggers.filter(t => t.getHandlerFunction() === 'checkPickReminders').length, 0);
  eq(pushes().length, before);
});

test('only ONE apiRegisterFcmToken / apiGetCareerHistory exists across backend files', () => {
  const dir = path.join(__dirname, '..', 'backend');
  const all = fs.readdirSync(dir).filter(f => f.endsWith('.gs')).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const names = [...all.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map(m => m[1]);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  eq([...new Set(dupes)], [], 'duplicate top-level functions across files silently override each other');
});

test('runDiagnostics completes and writes a report', () => {
  const env = loadBackend(); seedLeague(env);
  const rep = env.ctx.runDiagnostics();
  ok(rep.timings.length >= 7, 'timings');
  ok(rep.timings.every(t => t.ok), JSON.stringify(rep.timings.filter(t => !t.ok)));
  ok(env.ss.getSheetByName('DiagnosticsReport')._data.length > 10, 'report written');
  eq(env.ss.getSheetByName('DiagnosticsHistory')._data.length, 2);
});

test('client-side failures are recorded in PerfLog and surfaced by diagnostics', () => {
  const env = loadBackend(); seedLeague(env);
  env.call('getStandings'); // ensure PerfLog exists (sample or not, create it)
  if (!env.ss.getSheetByName('PerfLog')) env.ss.insertSheet('PerfLog').appendRow(['timestamp', 'action', 'ms', 'ok', 'error', 'reason', 'notes']);
  const r = env.call('logClientError', { failedAction: 'submitPicks', message: 'timed out after 25s', playerId: 'p2', at: '2026-09-26T22:58:00Z' });
  ok(r.ok);
  const rows = env.ss.getSheetByName('PerfLog')._data;
  const row = rows.find(x => x[1] === 'client:submitPicks');
  ok(row, 'client row written'); eq(row[5], 'client'); ok(/TEAM2/.test(row[6]));
  const rep = env.ctx.runDiagnostics();
  ok(rep.warnings.some(w => /phones/.test(w) && /TEAM2/.test(w)), JSON.stringify(rep.warnings));
});

test('getDiagnosticsSummary serves the latest report with NO player names', () => {
  const env = loadBackend(); seedLeague(env);
  const pl = env.ss.getSheetByName('Players'); const h = pl._data[0];
  pl._data.slice(1).forEach(row => { row[h.indexOf('pin')] = '1234'; }); // trigger the PIN warning
  env.ctx.runDiagnostics();
  const r = env.call('getDiagnosticsSummary');
  ok(r.ok && r.summary, 'summary present');
  ok(r.summary.timings.length >= 7);
  const text = JSON.stringify(r.summary);
  ok(/default PIN 1234/.test(text), 'PIN warning kept as a count');
  ok(!/TEAM2|TEAM3|VOLZ/.test(text), 'no team names leak: ' + text.slice(0, 300));
});

test('requests with no action are answered without touching the sheet or PerfLog', () => {
  const env = loadBackend(); seedLeague(env);
  const before = (env.ss.getSheetByName('PerfLog') || { _data: [] })._data.length;
  const r = JSON.parse(env.ctx.handle({ parameter: {} })._s);
  eq(r.ok, false); ok(r._version);
  eq((env.ss.getSheetByName('PerfLog') || { _data: [] })._data.length, before);
});

test('requests no longer write a DebugLog row each', () => {
  const env = loadBackend(); seedLeague(env);
  for (let i = 0; i < 5; i++) env.call('getStandings');
  eq(env.ss.getSheetByName('DebugLog'), null);
});

// ---------------------------------------------------------------- keepWarm / caches (2026-09-27)
function countBuilds(env) {
  const orig = env.ctx.buildSharedState_;
  const c = { n: 0 };
  env.ctx.buildSharedState_ = function() { c.n++; return orig(); };
  return c;
}

test('keepWarm without the onSheetChange trigger still rebuilds every run (old behavior)', () => {
  const env = loadBackend(); seedLeague(env);
  const b = countBuilds(env);
  env.ctx.keepWarm(); env.ctx.keepWarm();
  eq(b.n, 2);
});

test('keepWarm skips the rebuild when watched and nothing changed; rebuilds after writes, manual edits, or 15 min', () => {
  const env = loadBackend(); seedLeague(env);
  env.ctx.installSheetChangeTrigger();
  ok(env.triggers.some(t => t.getHandlerFunction() === 'onSheetChange'), 'trigger installed');
  const b = countBuilds(env);
  env.ctx.keepWarm(); eq(b.n, 1, 'cold cache -> build');
  env.ctx.keepWarm(); env.ctx.keepWarm(); eq(b.n, 1, 'fresh cache -> no rebuild');
  // app write -> handle() busts the cache
  ok(env.call('adminOverrideLine', { adminId: 'p1', gameId: 'g1', favorite: 'Away1', spread: 7 }).ok);
  env.ctx.keepWarm(); eq(b.n, 2, 'rebuilt after a write');
  eq(env.call('getState').games.find(g => g.gameId === 'g1').favorite, 'Away1');
  // manual edit in the sheet UI -> onSheetChange
  const gs = env.ss.getSheetByName('Games'); const h = gs._data[0];
  gs._data.forEach((row, i) => { if (i && row[h.indexOf('gameId')] === 'g2') row[h.indexOf('spread')] = 11; });
  env.ctx.onSheetChange({ changeType: 'EDIT' });
  eq(env.call('getState').games.find(g => g.gameId === 'g2').spread, 11, 'manual edit visible immediately');
  const n = b.n;
  env.ctx.keepWarm(); eq(b.n, n, 'getState already rebuilt it');
  // safety net: an old build is always rebuilt
  env.cache.put('appState_v3_builtAt', String(Date.now() - 16 * 60000));
  env.ctx.keepWarm(); eq(b.n, n + 1, 'rebuilt after 15 min');
});

test('keepWarm during live games fetches scores and re-caches them', () => {
  const env = loadBackend(); const { kickoff } = seedLeague(env, { kickoffOffset: -3600000 });
  env.ctx.installSheetChangeTrigger();
  env.ctx.keepWarm();
  espnEvents = [];
  for (let i = 1; i <= 10; i++) espnEvents.push(mkEvent('E' + i, 'Away' + i, 'Home' + i, { date: kickoff, homeScore: 7, awayScore: 3 }));
  env.props.lastAutoScoreFetch = '0';
  env.ctx.keepWarm();
  const cached = JSON.parse(env.ctx.cacheGetChunked_(env.cache, 'appState_v3'));
  eq(String(cached.games.find(g => g.gameId === 'g1').finalHomeScore), '7', 'fresh scores in the cache');
});

test('diagnostics keeps the sheetChangeTrigger flag in sync with the real trigger list', () => {
  const env = loadBackend(); seedLeague(env);
  env.ctx.installSheetChangeTrigger();
  eq(env.props.sheetChangeTrigger, '1');
  env.ctx.ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'onSheetChange').forEach(t => env.ctx.ScriptApp.deleteTrigger(t));
  env.ctx.runDiagnostics();
  eq(env.props.sheetChangeTrigger, '', 'flag cleared when the trigger is gone');
  const b = countBuilds(env);
  env.ctx.keepWarm(); env.ctx.keepWarm();
  eq(b.n, 2, 'falls back to rebuilding every run');
});

test('the Monday snapshot / missing-lines jobs bust the cached snapshotCount', () => {
  const env = loadBackend(); const { kickoff } = seedLeague(env);
  eq(env.call('getState').snapshotCount, 1);
  espnEvents.push(mkEvent('E300', 'Late A', 'Late B', { date: kickoff, odds: 'LAT -4' }));
  env.ctx._sheetDataCache = {};
  env.ctx.autoBackfillMissingLines();
  eq(env.call('getState').snapshotCount, 2);
});

test('career history cache: served from cache, and adminFixCareerMapping updates rows + busts it', () => {
  const env = loadBackend(); seedLeague(env);
  const ch = env.ss.getSheetByName('CareerHistory');
  ch._data.length = 0;
  ch.appendRow(['playerId', 'name', 'teamName', 'year', 'points', 'matched']);
  ch.appendRow(['legacy', '', 'Old Team2', 2019, 50, 'NO']);
  ch.appendRow(['legacy', '', 'Old Team2', 2020, 60, 'NO']);
  ch.appendRow(['legacy', '', 'Someone Else', 2020, 70, 'NO']);
  ch.appendRow(['legacy', '', 'OLD TEAM2', 2021, 80, 'NO']);
  env.ctx._sheetDataCache = {};
  env.ctx.clearCareerCache(); // seeding's getState cached the empty sheet
  eq(env.ctx.getCareerHistoryCached().length, 4);
  ch.appendRow(['legacy', '', 'Sneaky', 2022, 1, 'NO']); // script-side write with no invalidation
  env.ctx._sheetDataCache = {};
  eq(env.ctx.getCareerHistoryCached().length, 4, 'second read comes from cache');
  const r = env.call('adminFixCareerMapping', { adminId: 'p1', teamName: 'old team2', playerId: 'p2' });
  ok(r.ok, r.error); eq(r.updated, 3);
  env.ctx._sheetDataCache = {};
  const rows = env.ctx.getCareerHistoryCached();
  eq(rows.length, 5, 'cache was busted');
  eq(rows.filter(x => x.playerId === 'p2').map(x => x.year), [2019, 2020, 2021]);
  eq(rows.find(x => x.teamName === 'Someone Else').matched, 'NO', 'other rows untouched');
  eq(env.call('getState').players.find(p => p.id === 'p2').memberSince, 2019, 'memberSince refreshed too');
});

test('getState payload: no _row anywhere; submittedAt dropped only for weeks before last week', () => {
  const env = loadBackend(); seedLeague(env);
  env.call('submitPicks', picksPayload('p2', { gameId: 'g1', pickedTeam: 'Away1' }));
  const pk = env.ss.getSheetByName('Picks'); const h = pk._data[0];
  const old = h.map(c => ({ week: 1, playerId: 'p3', gameId: 'gOld', pickedTeam: 'X', isUpset: false, isAutoDefault: false, submittedAt: '2026-09-01T00:00:00Z' })[c] ?? '');
  pk.appendRow(old);
  env.ctx._sheetDataCache = {};
  env.ctx.setSeasonConfig('currentWeek', 3); env.ctx.invalidateStateCache();
  pk._data.forEach((row, i) => { if (i && row[h.indexOf('gameId')] !== 'gOld') row[h.indexOf('week')] = 2; });
  const s = env.call('getState');
  ok(!/"_row"/.test(JSON.stringify(s)), '_row leaked');
  const mine = s.picks.filter(p => p.playerId === 'p2');
  eq(mine.length, 11); ok(mine.every(p => p.submittedAt), 'last week keeps submittedAt');
  const o = s.picks.find(p => p.gameId === 'gOld');
  eq(o.submittedAt, undefined); eq(o.pickedTeam, 'X'); eq(o.isUpset, false);
  eq(env.call('getStandings').ok, true);
});

test('diagnostics summary stays valid JSON even when the report is huge', () => {
  const env = loadBackend(); seedLeague(env);
  const rep = env.ctx.runDiagnostics();
  for (let i = 0; i < 40; i++) rep.publicWarnings.push('warning number ' + i + ' ' + 'x'.repeat(400));
  for (let i = 0; i < 30; i++) rep.perf.push({ action: 'act' + i, logged: 9, p50: 1, p95: 2, max: 3, slow: 0, errors: 1, topError: 'e'.repeat(300) });
  env.ctx.saveDiagnosticsSummary_(rep);
  const r = env.call('getDiagnosticsSummary');
  ok(r.summary && r.summary.generatedAt, 'summary parsed: ' + JSON.stringify(r).slice(0, 200));
  ok(env.props.lastDiagnosticsSummary.length <= 8500);
  eq(rep.perf[rep.perf.length - 1].topError.length, 300, 'report itself (emailed later) not modified');
});

// ---------------------------------------------------------------- report
let failed = 0;
results.forEach(([pass, name, err]) => {
  console.log((pass ? '  PASS  ' : '  FAIL  ') + name + (err ? '\n    ' + err : ''));
  if (!pass) failed++;
});
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);
