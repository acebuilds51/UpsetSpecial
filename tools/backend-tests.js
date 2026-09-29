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
    getValue: () => cell(r, c),
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
const fetchLog = [];     // every UrlFetchApp.fetch call: { url, opts }
let mockWeekday = null;   // Utilities.formatDate(..., 'u') override: 1=Mon .. 7=Sun
let mailQuota = 100;      // MailApp.getRemainingDailyQuota()
const sentMails = [];     // every MailApp.sendEmail call
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
  fetchLog.length = 0;
  const ctx = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush: () => {} },
    CacheService: { getScriptCache: () => cache },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, tryLock: () => true, releaseLock: () => {} }) },
    Utilities: {
      getUuid: () => require('crypto').randomUUID(),
      formatDate: (d, tz, fmt) => fmt === 'u' ? String(mockWeekday != null ? mockWeekday : ((d.getDay() + 6) % 7) + 1) : d.toISOString().slice(0, 10).replace(/-/g, '')
    },
    Session: { getScriptTimeZone: () => 'America/New_York', getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    UrlFetchApp: {
      fetch: (url, opts) => {
        counters.fetch++; fetchLog.push({ url: String(url), opts: opts || {} });
        if (String(url).indexOf('frontdoor.example') >= 0) return { getResponseCode: () => 200, getContentText: () => '{"ok":true}' };
        return espnResponse();
      },
      fetchAll: reqs => { counters.fetchAll++; sentRequests.push(...reqs); return reqs.map(() => espnResponse()); }
    },
    MailApp: { sendEmail: m => { counters.mails++; sentMails.push(m); }, getRemainingDailyQuota: () => mailQuota },
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

// ---------------------------------------------------------------- default-PIN email
function setupPins(env) {
  const pl = env.ss.getSheetByName('Players'); const h = pl._data[0];
  const set = (id, pin, email, active) => pl._data.forEach((row, i) => { if (i && row[h.indexOf('id')] === id) { row[h.indexOf('pin')] = pin; row[h.indexOf('email')] = email; row[h.indexOf('active')] = active; } });
  set('p1', '9876', 'admin@example.com', true);   // changed PIN
  set('p2', '1234', 'pat@example.com', true);     // qualifies (numeric-looking string)
  set('p3', 1234, 'sam@example.com', true);       // qualifies (Sheets returns a number)
  const hdr = h;
  pl.appendRow(hdr.map(k => ({ id: 'p4', name: 'Old Timer', teamName: 'GONE', pin: '1234', active: false, email: 'gone@example.com' })[k] ?? '')); // inactive
  pl.appendRow(hdr.map(k => ({ id: 'p5', name: 'No Mail', teamName: 'NOMAIL', pin: '1234', active: true, email: '' })[k] ?? ''));           // no email
  env.ctx._sheetDataCache = {};
}

test('PIN email goes only to active players still on 1234 with an email, once per week', () => {
  const env = loadBackend(); seedLeague(env); setupPins(env);
  sentMails.length = 0; mailQuota = 100; mockWeekday = 2; // Tuesday
  const r = env.ctx.sendDefaultPinEmails();
  eq(r.sent, 2);
  eq(sentMails.map(m => m.to).sort(), ['pat@example.com', 'sam@example.com']);
  ok(/TEAM2/.test(sentMails.find(m => m.to === 'pat@example.com').htmlBody), 'personalized with their team name');
  ok(/Profile/.test(sentMails[0].htmlBody) && /Update PIN/.test(sentMails[0].htmlBody), 'has the how-to steps');
  eq(env.ctx.sendDefaultPinEmails().sent, 0, 'not re-sent within 6 days');
  mockWeekday = null;
});

test('PIN email refuses weekend/Monday sends and protects the daily quota', () => {
  const env = loadBackend(); seedLeague(env); setupPins(env);
  sentMails.length = 0;
  mockWeekday = 6; mailQuota = 100;  // Saturday -- pick-reminder day
  eq(env.ctx.sendDefaultPinEmails().skipped, 'day');
  mockWeekday = 3; mailQuota = 41;   // Wednesday but only 41 left: 2 + 40 reserve > 41
  eq(env.ctx.sendDefaultPinEmails().skipped, 'quota');
  eq(sentMails.length, 0);
  mockWeekday = null; mailQuota = 100;
});

test('changePin rejects 1234 and non-digit PINs', () => {
  const env = loadBackend(); seedLeague(env); setupPins(env);
  eq(env.call('changePin', { playerId: 'p2', currentPin: '1234', newPin: '1234' }).ok, false);
  eq(env.call('changePin', { playerId: 'p2', currentPin: '1234', newPin: 'abcd' }).ok, false);
  eq(env.call('changePin', { playerId: 'p2', currentPin: '1234', newPin: '1234567' }).ok, false);
  ok(/start with 0/.test(env.call('changePin', { playerId: 'p2', currentPin: '1234', newPin: '0123' }).error), 'leading 0 rejected');
  ok(/start with 0/.test(env.call('registerPlayer', { name: 'New Guy', teamName: 'NEWGUY', pin: '0456', email: 'n@example.com' }).error), 'leading 0 rejected at sign-up');
  eq(env.call('adminUpdatePlayer', { adminId: 'p1', id: 'p3', pin: '0999' }).ok, false);
  ok(env.call('adminUpdatePlayer', { adminId: 'p1', id: 'p3', active: true }).ok, 'admin edits without a PIN still work');
  ok(env.call('changePin', { playerId: 'p2', currentPin: '1234', newPin: '8642' }).ok);
});

// ---------------------------------------------------------------- AI results-email checker
// Modeled on the real Week 4 2026 recap (player names replaced): 3 false alarms
// the old checker raised, 4 real errors it missed.
function week4RecapFixture() {
  const game = (awayTeam, a, homeTeam, h, favorite, spread) => {
    const dog = favorite === homeTeam ? awayTeam : homeTeam;
    const favMargin = favorite === homeTeam ? h - a : a - h;
    return { awayTeam, homeTeam, awayScore: a, homeScore: h, favorite, dog, spread, winner: a > h ? awayTeam : homeTeam, coveringTeam: favMargin > spread ? favorite : dog };
  };
  const perf = (team, correct, upsetHit, weekPts) => ({ team, correct, total: 10, upsetHit, upsetMiss: null, weekPts, perfect: false });
  const performances = [
    perf('ALPHA', 8, 'Minnesota Golden Gophers +10', 18), perf('BRAVO', 7, 'Minnesota Golden Gophers +10', 17),
    perf('CHARLIE', 4, 'Wake Forest Demon Deacons +12.5', 16.5), perf('DELTA', 6, 'Wisconsin Badgers +9.5', 15.5),
    perf('ECHO', 8, 'Cincinnati Bearcats +6.5', 14.5), perf('FOXTROT', 7, 'UAB Blazers +7', 14),
    perf('GOLF', 7, 'Cincinnati Bearcats +6.5', 13.5), perf('HOTEL', 3, 'Minnesota Golden Gophers +10', 13),
    perf('INDIA', 8, 'Iowa Hawkeyes +5.5', 13.5), perf('JULIETT', 7, 'Iowa Hawkeyes +5.5', 12.5),
    perf('KILO', 6, 'Cincinnati Bearcats +6.5', 12.5), perf('LIMA', 6, 'Iowa Hawkeyes +5.5', 11.5)
  ];
  return {
    performances, upsetHitters: performances.filter(p => p.upsetHit), perfectWeeks: [],
    gameResults: [
      game('Texas Longhorns', 20, 'Tennessee Volunteers', 17, 'Texas Longhorns', 5.5),
      game('Iowa Hawkeyes', 20, 'Michigan Wolverines', 19, 'Michigan Wolverines', 5.5),
      game('South Carolina Gamecocks', 18, 'Alabama Crimson Tide', 49, 'Alabama Crimson Tide', 12.5),
      game('Oklahoma Sooners', 13, 'Georgia Bulldogs', 41, 'Georgia Bulldogs', 14),
      game('Texas A&M Aggies', 6, 'LSU Tigers', 35, 'LSU Tigers', 8.5)
    ]
  };
}
const P = t => '<p style="margin-bottom:16px;">' + t + '</p>';
const WEEK4_GOOD = [
  P('Michigan didn\'t just lose the game — they failed to cover by a mile. Tennessee held <strong>Texas</strong> to a 3-point win, meaning the <strong>Volunteers</strong> covered too.'),
  P('<strong>ALPHA</strong> leads at 18 pts. <strong>BRAVO</strong> (17 pts, 7/10) also hit the Minnesota ticket. Close behind: <strong>CHARLIE</strong> at 16.5 pts, <strong>DELTA</strong> cashes at 15.5 pts, and <strong>ECHO</strong> lands at 14.5 pts.'),
  '<ul style="list-style:none;"><li>&rarr; ALPHA — 18 pts</li><li>&rarr; CHARLIE — 16.5 pts</li></ul>',
  P('The <strong>Minnesota Golden Gophers</strong> +10 rewarded ALPHA, BRAVO, and HOTEL. The <strong>Cincinnati Bearcats</strong> +6.5 paid out ECHO, GOLF, and KILO. The Iowa Hawkeyes +5.5 made INDIA, JULIETT, and LIMA look smart. FOXTROT rode UAB alone.'),
  P('Alabama did the same to South Carolina, 49–18, a 31-point margin. Georgia covered the 14 with ease.')
].join('');

test('recap checker: no false alarms on a correct recap (points, "failed to cover", underdog covering)', () => {
  const env = loadBackend();
  eq(env.ctx.validateRecapAccuracy_(WEEK4_GOOD, week4RecapFixture()), []);
});

test('recap checker: catches the real Week 4 mistakes (wrong group, margin, "most popular", wrong cover, cut-off)', () => {
  const env = loadBackend();
  const bad = WEEK4_GOOD
    .replace('The <strong>Minnesota Golden Gophers</strong> +10 rewarded', 'The <strong>Minnesota Golden Gophers</strong> +10 was the most popular ticket, rewarding')
    .replace('paid out ECHO, GOLF, and KILO', 'paid out ECHO, FOXTROT, GOLF, and KILO')
    .replace('a 31-point margin', 'a 36-point margin')
    .replace('Georgia covered the 14 with ease.', 'Georgia covered the 14 with ease. Texas covered the 5.5.')
    + '<hr style="border:none;border-top:1px solid #ebe5d8;margin:';
  const errs = env.ctx.validateRecapAccuracy_(bad, week4RecapFixture());
  const has = re => ok(errs.some(e => re.test(e)), 'expected ' + re + ' in:\n  ' + errs.join('\n  '));
  has(/FOXTROT is grouped with the Cincinnati Bearcats.*UAB Blazers/);
  has(/most popular.*tied at 3/);
  has(/margin as 36.*31-point/);
  has(/says Texas Longhorns covered, but Tennessee Volunteers/);
  has(/cut off/);
  ok(!errs.some(e => /credited with/.test(e)), 'no false point-total alarms: ' + errs.join(' | '));
  ok(!errs.some(e => /Michigan Wolverines covered/.test(e)), 'no false Michigan alarm');
});

test('REGRESSION (wk5): ESPN odds using a shorter team code still find the favorite ("AF -3.5" vs abbr AFA)', () => {
  const env = loadBackend();
  const ev = { id: '401862791', date: '2026-10-03T16:00Z', competitions: [{ odds: [{ details: 'AF -3.5' }], competitors: [
    { homeAway: 'home', team: { displayName: 'Air Force Falcons', abbreviation: 'AFA' } },
    { homeAway: 'away', team: { displayName: 'Navy Midshipmen', abbreviation: 'NAVY' } }] }] };
  const c = ev.competitions[0];
  const line = env.ctx.extractEspnLine(ev, c, c.competitors[0], c.competitors[1]);
  eq(line.favorite, 'Air Force Falcons'); eq(line.spread, 3.5);
  // unchanged behavior for the normal case
  const ev2 = { id: '2', competitions: [{ odds: [{ details: 'ALA -12.5' }], competitors: [
    { homeAway: 'home', team: { displayName: 'Alabama Crimson Tide', abbreviation: 'ALA' } },
    { homeAway: 'away', team: { displayName: 'South Carolina Gamecocks', abbreviation: 'SC' } }] }] };
  const c2 = ev2.competitions[0];
  eq(env.ctx.extractEspnLine(ev2, c2, c2.competitors[0], c2.competitors[1]).favorite, 'Alabama Crimson Tide');
});

test('compact picks: server packing + the app\'s own unpackPicks() round-trip exactly, and much smaller', () => {
  const env = loadBackend(); seedLeague(env);
  env.call('submitPicks', picksPayload('p2', { espnEventId: 'E100', awayTeam: 'Dog U', homeTeam: 'Fav U', pickedTeam: 'Dog U' }));
  env.call('submitPicks', picksPayload('p3', { gameId: 'g1', pickedTeam: 'Away1' }));
  const full = env.call('getState');
  const packed = env.call('getState', { compact: 1 });
  ok(Array.isArray(full.picks) && !full.picksCompact, 'old app versions still get plain picks');
  ok(packed.picksCompact && !packed.picks, 'new app versions get packed picks');
  // run the REAL unpackPicks from index.html
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const src = html.slice(html.indexOf('function unpackPicks('), html.indexOf('function seasonArrToObj('));
  const ctx = {}; vm.createContext(ctx); vm.runInContext(src, ctx);
  const round = ctx.unpackPicks(JSON.parse(JSON.stringify(packed)));
  eq(JSON.parse(JSON.stringify(round)), JSON.parse(JSON.stringify(full.picks)), 'identical after unpacking');
  eq(ctx.unpackPicks({ picks: [{ week: 1 }] }), [{ week: 1 }], 'an older cached copy with plain picks still loads');
  ok(JSON.stringify(packed.picksCompact).length < JSON.stringify(full.picks).length / 2, 'at least 2x smaller even on tiny data');
});

// ---------------------------------------------------------------- Post Week line check
function seedUnpostedWeek2(env, flipFavoriteOn) {
  const kickoff = new Date(Date.now() + 2 * DAY).toISOString();
  const gs = env.ss.getSheetByName('Games'); const h = gs._data[0];
  espnEvents = [];
  for (let i = 1; i <= 3; i++) {
    const fav = (flipFavoriteOn === i) ? 'W2Away' + i : 'W2Home' + i; // board favorite
    gs.appendRow(h.map(k => ({ week: 2, gameId: 'w2g' + i, espnEventId: 'W2E' + i, awayTeam: 'W2Away' + i, homeTeam: 'W2Home' + i, favorite: fav, spread: 3, source: 'espn', kickoff, locked: false, isFinal: false })[k] ?? ''));
    // ESPN: home team favored by 3 (odds code = home abbreviation)
    espnEvents.push(mkEvent('W2E' + i, 'W2Away' + i, 'W2Home' + i, { date: kickoff, odds: 'W2H -3' }));
  }
  env.props.lastAutoScoreFetch = String(Date.now());
  env.ctx.invalidateStateCache(); env.ctx._sheetDataCache = {};
}
const w2Locked = env => rowsOf(env, 'Games').filter(g => g.week === 2 && g.locked === true).length;

test('Post Week: a favorite that differs from ESPN\'s opening line needs confirmation', () => {
  const env = loadBackend(); seedLeague(env); seedUnpostedWeek2(env, 2);
  let r = env.call('adminPostWeek', { adminId: 'p1', week: 2, checkLines: true });
  ok(r.ok && r.needsConfirm && r.posted === false, JSON.stringify(r));
  eq(r.mismatches.length, 1); eq(r.mismatches[0].kind, 'favorite');
  ok(/W2Away2 by 3/.test(r.mismatches[0].board) && /W2Home2 by 3/.test(r.mismatches[0].espn), JSON.stringify(r.mismatches[0]));
  eq(w2Locked(env), 0, 'nothing posted yet');
  r = env.call('adminPostWeek', { adminId: 'p1', week: 2, checkLines: true, confirmLineMismatches: true });
  ok(r.ok && !r.needsConfirm); eq(w2Locked(env), 3, 'posted after confirming');
});

test('Post Week: matching lines post straight away; older apps (no checkLines) post as before', () => {
  let env = loadBackend(); seedLeague(env); seedUnpostedWeek2(env, null);
  let r = env.call('adminPostWeek', { adminId: 'p1', week: 2, checkLines: true });
  ok(r.ok && !r.needsConfirm, JSON.stringify(r)); eq(w2Locked(env), 3);
  env = loadBackend(); seedLeague(env); seedUnpostedWeek2(env, 1);
  r = env.call('adminPostWeek', { adminId: 'p1', week: 2 });
  ok(r.ok && !r.needsConfirm); eq(w2Locked(env), 3, 'old app behavior unchanged');
});

test('Post Week refusal names EVERY incomplete game and what it lacks', () => {
  const env = loadBackend(); seedLeague(env); seedUnpostedWeek2(env, null);
  const gs = env.ss.getSheetByName('Games'); const h = gs._data[0];
  gs._data.forEach(row => {
    if (row[h.indexOf('gameId')] === 'w2g1') row[h.indexOf('kickoff')] = '';
    if (row[h.indexOf('gameId')] === 'w2g3') { row[h.indexOf('spread')] = ''; row[h.indexOf('favorite')] = ''; }
  });
  env.ctx._sheetDataCache = {};
  const r = env.call('adminPostWeek', { adminId: 'p1', week: 2, checkLines: true });
  ok(!r.ok, 'refused');
  eq(r.incomplete.map(x => x.gameId), ['w2g1', 'w2g3']);
  eq(r.incomplete[1].missing, ['favorite', 'spread']);
  ok(/W2Away1 @ W2Home1 \(no kickoff\)/.test(r.error) && /W2Away3 @ W2Home3 \(no favorite, no spread\)/.test(r.error), r.error);
  eq(w2Locked(env), 0, 'nothing posted');
});

// ---------------------------------------------------------------- ledger batch (Week N prizes)
test('ledger batch: records all rows in one write; a repeat (double tap / lost reply) never pays twice', () => {
  const env = loadBackend(); seedLeague(env);
  const entries = [
    { playerId: 'p2', type: 'weekly_prize', amount: 50, note: 'Week 1' },
    { playerId: 'p3', type: 'weekly_prize', amount: 50, note: 'Week 1' },
    { playerId: 'p1', type: 'weekly_prize', amount: 33.33, note: 'Week 1' }
  ];
  let r = env.call('adminLedgerBatch', { adminId: 'p1', entries });
  ok(r.ok, JSON.stringify(r)); eq(r.recorded, 3); eq(r.skipped, 0);
  r = env.call('adminLedgerBatch', { adminId: 'p1', entries });
  eq([r.recorded, r.skipped], [0, 3], 'second tap records nothing');
  r = env.call('adminLedgerBatch', { adminId: 'p1', entries: [{ playerId: 'p2', type: 'weekly_prize', amount: 50, note: 'Week 2' }] });
  eq(r.recorded, 1, 'a different week is a new payout');
  const rows = rowsOf(env, 'Ledger');
  eq(rows.length, 4); eq(rows.filter(x => x.note === 'Week 1').length, 3);
  eq(env.call('getState', { compact: 1 }).ledger.length, 4, 'visible on the next app load');
  ok(!env.call('adminLedgerBatch', { adminId: 'p1', entries: [{ playerId: 'p2', type: 'weekly_prize', amount: 0, note: 'Week 3' }] }).ok, 'zero amount rejected');
  ok(!env.call('adminLedgerBatch', { adminId: 'p1', entries: [{ playerId: 'p2', type: 'bogus', amount: 5, note: 'Week 3' }] }).ok, 'unknown type rejected');
  ok(!env.call('adminLedgerBatch', { adminId: 'p1', entries: [{ playerId: 'p2', type: 'perfect_bonus', amount: 100, note: 'Week 3' }] }).ok, 'the retired perfect-week bonus is not paid');
  ok(!env.call('adminLedgerBatch', { adminId: 'p2', entries }).ok, 'non-admin rejected');
});

// ---------------------------------------------------------------- AI recap draft + check log
function stubRecap(env, texts) {
  const fx = week4RecapFixture();
  Object.assign(fx, { week: 4, year: 2026, gameLines: fx.gameResults.map(g => g.awayTeam + ' @ ' + g.homeTeam) });
  env.ctx.buildWeekRecap_ = () => fx;
  env.ctx.buildOfficialBoxScoreHtml_ = () => '<div>BOX</div>';
  env.props.ANTHROPIC_API_KEY = 'test-key';
  let n = 0;
  env.ctx.UrlFetchApp.fetch = () => {
    const text = texts[Math.min(n++, texts.length - 1)];
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }) };
  };
  return () => n;
}
const recapRows = env => { const s = env.ss.getSheetByName('PerfLog'); return s ? s._data.filter(r => r[1] === 'recapCheck') : []; };

test('recap: the draft is saved server-side and can be loaded again (lost reply / closed tab)', () => {
  const env = loadBackend(); seedLeague(env);
  const calls = stubRecap(env, [WEEK4_GOOD]);
  eq(env.call('adminGetResultsDraft', { adminId: 'p1', week: 4 }).draft, null, 'nothing saved yet');
  const d = env.call('adminGenerateResultsEmail', { adminId: 'p1', week: 4 });
  ok(d.ok && d.verified, JSON.stringify(d.validationIssues)); eq(d.attempts, 1); eq(calls(), 1, 'one AI call when the check passes');
  const saved = env.call('adminGetResultsDraft', { adminId: 'p1', week: 4 }).draft;
  eq(saved.bodyHtml, d.bodyHtml); eq(saved.verified, true); ok(saved.html && saved.generatedAt);
  ok(/BOX/.test(saved.bodyHtml), 'box score kept');
  eq(env.call('adminGetResultsDraft', { adminId: 'p1', week: 5 }).draft, null, 'per week');
  ok(!env.call('adminGetResultsDraft', { adminId: 'p2', week: 4 }).ok, 'admins only');
  const rows = recapRows(env); eq(rows.length, 1); eq(rows[0][3], true); eq(rows[0][4], '', 'no issues logged on a clean first pass');
});

test('recap: every attempt\'s accuracy issues are logged to PerfLog (recapCheck) so the repeat failure can be fixed', () => {
  const env = loadBackend(); seedLeague(env);
  const bad = WEEK4_GOOD.replace('a 31-point margin', 'a 36-point margin');
  const calls = stubRecap(env, [bad]);
  const d = env.call('adminGenerateResultsEmail', { adminId: 'p1', week: 4 });
  ok(d.ok && !d.verified); eq(d.attempts, 3); eq(calls(), 3);
  const rows = recapRows(env); eq(rows.length, 1);
  eq(rows[0][3], false); ok(/36/.test(rows[0][4]), 'first attempt issue in the error column: ' + rows[0][4]);
  eq(JSON.parse(rows[0][6]).attempts.length, 3);
  ok(env.call('adminGetResultsDraft', { adminId: 'p1', week: 4 }).draft.validationIssues.length > 0, 'unverified draft is still saved');
});

test('recap sent: a real send tagged with the week is remembered for the admin to-do strip; tests are not', () => {
  const env = loadBackend(); seedLeague(env);
  const players = env.ss.getSheetByName('Players'); const h = players._data[0];
  players._data.forEach((row, i) => { if (i > 0) row[h.indexOf('email')] = 'x' + i + '@example.com'; });
  env.ctx._sheetDataCache = {};
  const season = () => { const s = {}; env.call('getState').season.forEach(r => s[r.key] = r.value); return s; };
  const mail = { adminId: 'p1', subject: 'S', title: 'T', subtitle: '', bodyHtml: '<p>b</p>' };
  ok(env.call('adminSendCustomEmail', Object.assign({ testOnly: true, recapWeek: 3 }, mail)).ok);
  ok(!season().recapSentWeeks, 'a test send is not a recap send');
  env.call('adminSendCustomEmail', Object.assign({ recapWeek: 3 }, mail));
  env.call('adminSendCustomEmail', Object.assign({ recapWeek: 1 }, mail));
  env.call('adminSendCustomEmail', Object.assign({ recapWeek: 3 }, mail));
  eq(season().recapSentWeeks, 'y' + season().year + ':1,3', 'visible in the next getState (cache busted), deduped and sorted');
});

// ---------------------------------------------------------------- picks cache
test('picks cache: repeat app loads skip the sheet; submissions and ledger entries show up immediately', () => {
  const env = loadBackend(); seedLeague(env);
  const unpack = d => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const ctx = {}; vm.createContext(ctx);
    vm.runInContext(html.slice(html.indexOf('function unpackPicks('), html.indexOf('function seasonArrToObj(')), ctx);
    return ctx.unpackPicks(d);
  };
  eq(unpack(env.call('getState', { compact: 1 })).length, 0);
  ok(env.cache.get('picksBundle_v1_n'), 'picks bundle cached');
  env.call('submitPicks', picksPayload('p2', { gameId: 'g1', pickedTeam: 'Away1' }));
  eq(unpack(env.call('getState', { compact: 1 })).filter(p => p.playerId === 'p2').length, 11, 'new picks visible on the next load');
  env.call('adminLedgerEntry', { adminId: 'p1', playerId: 'p2', type: 'payout', amount: 100 });
  eq(env.call('getState', { compact: 1 }).ledger.length, 1, 'ledger entry visible on the next load');
  // a direct (non-app) write through the helpers busts it too
  env.ctx.appendObjects_('Picks', [{ week: 1, playerId: 'p3', gameId: 'g2', pickedTeam: 'Home2', isUpset: false, isAutoDefault: true }]);
  eq(unpack(env.call('getState', { compact: 1 })).filter(p => p.playerId === 'p3').length, 1);
});

test('GET requests are recorded (action + parameter names only) in the diagnostics summary', () => {
  const env = loadBackend(); seedLeague(env);
  env.ctx.handle({ parameter: {} });
  env.ctx.handle({ parameter: { action: 'getState', playerId: 'p_secret123' } });
  const r = env.call('getDiagnosticsSummary');
  eq(r.getRequests.length, 2);
  eq(r.getRequests[1].action, 'getState'); eq(r.getRequests[1].params, 'playerId');
  ok(!JSON.stringify(r.getRequests).includes('p_secret123'), 'parameter values never recorded');
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

// ---- partial pick saves
const straightOnly = (playerId, nums, team = 'Home') => ({ week: 1, playerId, picks: nums.map(i => ({ gameId: 'g' + i, pickedTeam: team + i, isUpset: false })) });

test('submitPicks accepts a partial board and reports what is still missing', () => {
  const env = loadBackend(); seedLeague(env);
  const r = env.call('submitPicks', straightOnly('p2', [1, 2, 3, 4, 5, 6]));
  ok(r.ok, r.error); eq(r.missing, 4); eq(r.hasUpset, false);
  eq(rowsOf(env, 'Picks').filter(p => p.playerId === 'p2').length, 6);
});

test('a later partial save adds to earlier picks instead of erasing them', () => {
  const env = loadBackend(); seedLeague(env);
  env.call('submitPicks', straightOnly('p2', [1, 2, 3]));
  const second = straightOnly('p2', [4, 5, 6, 7, 8, 9, 10]);
  second.picks.push({ gameId: 'g2', pickedTeam: 'Away2', isUpset: true });
  second.picks.push({ gameId: 'g2', pickedTeam: 'Away2', isUpset: false }); // board upset: straight = same underdog
  const r = env.call('submitPicks', second);
  ok(r.ok, r.error); eq(r.missing, 0); eq(r.hasUpset, true);
  const mine = rowsOf(env, 'Picks').filter(p => p.playerId === 'p2');
  eq(mine.length, 11);
  eq(mine.find(p => p.gameId === 'g1').pickedTeam, 'Home1', 'first save kept');
  eq(mine.find(p => p.gameId === 'g2' && p.isUpset !== true).pickedTeam, 'Away2', 'resent game updated');
  // saving straight picks only keeps the saved Upset Special
  ok(env.call('submitPicks', straightOnly('p2', [5], 'Away')).ok);
  const after = rowsOf(env, 'Picks').filter(p => p.playerId === 'p2');
  eq(after.length, 11); eq(after.filter(p => p.isUpset === true).map(p => p.gameId), ['g2']);
  eq(after.find(p => p.gameId === 'g5').pickedTeam, 'Away5');
});

test('partial save leaves a locked game\'s saved pick alone and still saves the open ones', () => {
  const env = loadBackend(); seedLeague(env);
  ok(env.call('submitPicks', straightOnly('p2', [1, 2])).ok);
  const gs = env.ss.getSheetByName('Games'); const h = gs._data[0];
  gs._data.forEach((row, i) => { if (i && row[h.indexOf('gameId')] === 'g1') row[h.indexOf('kickoff')] = new Date(Date.now() - 3600000).toISOString(); });
  env.ctx.invalidateStateCache(); env.ctx._sheetDataCache = {};
  const r = env.call('submitPicks', straightOnly('p2', [3, 4]));
  ok(r.ok, r.error);
  const mine = rowsOf(env, 'Picks').filter(p => p.playerId === 'p2');
  eq(mine.map(p => p.gameId).sort(), ['g1', 'g2', 'g3', 'g4']);
  eq(env.call('submitPicks', straightOnly('p2', [1], 'Away')).ok, false, 'changing the locked game is still refused');
});

test('submitPicks rejects empty, off-board and duplicate picks', () => {
  const env = loadBackend(); seedLeague(env);
  eq(env.call('submitPicks', { week: 1, playerId: 'p2', picks: [] }).ok, false);
  eq(env.call('submitPicks', { week: 1, playerId: 'p2', picks: [{ gameId: 'nope', pickedTeam: 'X', isUpset: false }] }).ok, false);
  eq(env.call('submitPicks', { week: 1, playerId: 'p2', picks: [{ gameId: 'g1', pickedTeam: 'Home1', isUpset: false }, { gameId: 'g1', pickedTeam: 'Away1', isUpset: false }] }).ok, false);
  eq(rowsOf(env, 'Picks').length, 0);
});

test('pick reminders tell a partial saver exactly what is left', () => {
  const env = loadBackend(); seedLeague(env); setupPins(env);
  env.call('submitPicks', straightOnly('p2', [1, 2, 3, 4, 5, 6, 7]));   // 3 games + upset left
  env.call('submitPicks', picksPayload('p3', { gameId: 'g1', pickedTeam: 'Away1' })); // complete
  env.ctx._sheetDataCache = {};
  sentMails.length = 0; mailQuota = 100;
  env.ctx.sendPickReminders();
  const toPat = sentMails.filter(m => m.to === 'pat@example.com');
  eq(toPat.length, 1); ok(/3 games and your Upset Special/.test(toPat[0].htmlBody), 'says what is left');
  eq(sentMails.filter(m => m.to === 'sam@example.com').length, 0, 'complete player not reminded');
  ok(/5 minutes before/.test(toPat[0].htmlBody) && !/10 minutes/.test(toPat[0].htmlBody), 'lock time is 5 minutes');
});

// ---------------------------------------------------------------- 2026-09-29 pass
function countSheetReads(env) {
  const orig = env.ctx.sheetToObjects;
  const c = {};
  env.ctx.sheetToObjects = function(name) { if (!env.ctx._sheetDataCache[name]) c[name] = (c[name] || 0) + 1; return orig(name); };
  return c;
}

test('BUG FIX: Trophy Room counts this season\'s Upset Specials once (not again after the week wrap-up)', () => {
  const env = loadBackend(); const { kickoff } = seedLeague(env);
  const pl = env.ss.getSheetByName('Players'); const ph = pl._data[0];
  pl._data.forEach((row, i) => { if (i && row[ph.indexOf('id')] === 'p2') row[ph.indexOf('avatar')] = 'data:image/png;base64,AAA'; });
  env.ctx.invalidateStateCache();
  env.call('submitPicks', picksPayload('p2', { espnEventId: 'E100', awayTeam: 'Dog U', homeTeam: 'Fav U', pickedTeam: 'Dog U' }));
  finishWeek(env, kickoff, 2);
  const room = () => { env.cache.remove('trophy_v4_p2'); return env.call('getTrophyRoom', { playerId: 'p2' }); };
  let t = room();
  ok(t.ok, t.error);
  eq([t.upsetAttempts, t.upsetHits, t.totalUpsetPts], [1, 1, 14], 'before the wrap-up: counted from picks');
  eq(t.biggestUpset.spread, 14);
  eq(t.player.avatar, 'data:image/png;base64,AAA', 'own avatar still returned');
  eq(t.player.teamName, 'TEAM2');
  env.ctx._sheetDataCache = {};
  env.ctx.checkGameFinalNotifications(); // writes week 1 to UpsetHistory
  t = room();
  eq([t.upsetAttempts, t.upsetHits, t.totalUpsetPts], [1, 1, 14], 'after the wrap-up: counted once (was 2/2/28)');
  // older seasons from UpsetHistory still add up, biggest hit wins; other teams ignored
  const uh = env.ss.getSheetByName('UpsetHistory'); const uhh = uh._data[0];
  const add = o => uh.appendRow(uhh.map(h => o[h] ?? ''));
  add({ year: 2019, week: 3, teamName: 'TEAM2', upsetPick: 'Old Dog', spread: 20, attempted: true, hit: true, upsetPts: 20 });
  add({ year: 2019, week: 4, teamName: 'TEAM2', upsetPick: 'Miss', spread: 5, attempted: true, hit: false, upsetPts: 0 });
  add({ year: 2019, week: 3, teamName: 'TEAM3', upsetPick: 'Huge', spread: 40, attempted: true, hit: true, upsetPts: 40 });
  env.ctx.onSheetChange({ changeType: 'EDIT' });
  t = room();
  eq([t.upsetAttempts, t.upsetHits, t.totalUpsetPts], [3, 2, 34]);
  eq(t.biggestUpset, { team: 'Old Dog', spread: 20, year: 2019, week: 3 });
  // a repeat visit reads neither the whole Picks nor UpsetHistory nor Players tab
  const reads = countSheetReads(env);
  env.ctx._sheetDataCache = {};
  t = room();
  ok(t.ok); eq([reads.Picks, reads.UpsetHistory, reads.Players], [undefined, undefined, undefined], JSON.stringify(reads));
});

test('keepWarm keeps the picks cache as long as the state cache when watched; the 15-min rebuild refreshes it', () => {
  const env = loadBackend(); seedLeague(env);
  const ttls = {};
  const putAll = env.cache.putAll;
  env.cache.putAll = (o, ttl) => { Object.keys(o).forEach(k => { ttls[k.replace(/_(\d+|n)$/, '')] = ttl; }); return putAll(o, ttl); };
  env.ctx.keepWarm();
  eq(ttls.picksBundle_v1, 600, 'unwatched: unchanged 10 min');
  env.ctx.installSheetChangeTrigger();
  env.ctx.invalidateStateCache();
  env.ctx.keepWarm();
  eq(ttls.picksBundle_v1, 1500, 'watched: outlives the 15-min safety net');
  // a raw script write that bypassed the helpers shows up after the 15-min rebuild
  const pk = env.ss.getSheetByName('Picks'); const h = pk._data[0];
  pk.appendRow(h.map(c => ({ week: 1, playerId: 'p3', gameId: 'g2', pickedTeam: 'Home2', isUpset: false })[c] ?? ''));
  env.ctx.keepWarm();
  eq(env.call('getState', { compact: 1 }).picksCompact.r.length, 0, 'still cached (fresh)');
  env.cache.put('appState_v3_builtAt', String(Date.now() - 16 * 60000));
  env.ctx.keepWarm();
  eq(env.call('getState', { compact: 1 }).picksCompact.r.length, 1, 'refreshed with the state');
});

test('live games: players\' getState leaves the score fetch to keepWarm unless keepWarm missed a run', () => {
  const env = loadBackend(); const { kickoff } = seedLeague(env, { kickoffOffset: -3600000 });
  espnEvents = [];
  for (let i = 1; i <= 10; i++) espnEvents.push(mkEvent('E' + i, 'Away' + i, 'Home' + i, { date: kickoff, homeScore: 7, awayScore: 3 }));
  const ago = min => String(Date.now() - min * 60000);
  env.props.lastAutoScoreFetch = ago(4.5);
  env.call('getState');
  ok(Number(env.props.lastAutoScoreFetch) < Date.now() - 4 * 60000, 'user did not fetch');
  env.ctx.keepWarm();
  ok(Number(env.props.lastAutoScoreFetch) > Date.now() - 60000, 'keepWarm fetched');
  env.props.lastAutoScoreFetch = ago(8);
  const s = env.call('getState');
  ok(Number(env.props.lastAutoScoreFetch) > Date.now() - 60000, 'user fetched after keepWarm missed a run');
  eq(String(s.games.find(g => g.gameId === 'g1').finalHomeScore), '7', 'and got the fresh scores');
});

test('approving a name claim links CareerHistory in one write per column, touching only matching rows', () => {
  const env = loadBackend(); seedLeague(env);
  const ch = env.ss.getSheetByName('CareerHistory');
  ch._data.length = 0;
  ch.appendRow(['playerId', 'name', 'teamName', 'year', 'points', 'matched']);
  ch.appendRow(['', '', 'Old Team2', 2019, 50, 'NO']);
  ch.appendRow(['x9', '', 'Someone Else', 2020, 70, 'NO']);
  ch.appendRow(['', '', 'OLD TEAM2', 2021, 80, 'NO']);
  const nc = env.ss.getSheetByName('NameClaims'); const nh = nc._data[0];
  nc.appendRow(nh.map(h => ({ claimId: 'c1', playerId: 'p2', claimedTeamName: 'old team2', status: 'pending' })[h] ?? ''));
  env.ctx._sheetDataCache = {};
  let setValueCalls = 0;
  const getRange = ch.getRange;
  ch.getRange = (...a) => { const r = getRange(...a); const sv = r.setValue; r.setValue = v => { setValueCalls++; return sv(v); }; return r; };
  const r = env.call('adminReviewNameClaim', { adminId: 'p1', claimId: 'c1', decision: 'approved' });
  ok(r.ok, r.error);
  eq(setValueCalls, 0, 'no per-cell writes');
  const rows = rowsOf(env, 'CareerHistory');
  eq(rows.map(x => [x.playerId, x.matched]), [['p2', 'YES'], ['x9', 'NO'], ['p2', 'YES']]);
  eq(rows.map(x => x.points), [50, 70, 80], 'other columns untouched');
});

// ---------------------------------------------------------------- Cloudflare front door (phase 2)
const staleSignals = () => fetchLog.filter(c => c.url.indexOf('frontdoor.example') >= 0);
function enableFrontDoor(env) {
  env.props.FRONT_DOOR_URL = 'https://frontdoor.example/';
  env.props.FRONT_DOOR_SECRET = 'test-secret';
}

test('front door: nothing is sent until FRONT_DOOR_URL and FRONT_DOOR_SECRET are set', () => {
  const env = loadBackend(); seedLeague(env);
  ok(env.call('adminOverrideLine', { adminId: 'p1', gameId: 'g1', favorite: 'Away1', spread: 7 }).ok);
  env.ctx.onSheetChange({});
  eq(staleSignals().length, 0);
});

test('front door: a web write sends ONE stale signal (with the secret), after the change; a plain read sends none', () => {
  const env = loadBackend(); seedLeague(env); enableFrontDoor(env);
  env.call('getState'); env.call('getStandings');
  eq(staleSignals().length, 0, 'reads that change nothing');
  ok(env.call('submitPicks', picksPayload('p2', { gameId: 'g1', pickedTeam: 'Away1' })).ok);
  eq(staleSignals().length, 1, 'several caches busted, one signal');
  const sig = staleSignals()[0];
  eq(JSON.parse(sig.opts.payload), { action: 'frontDoorStale', secret: 'test-secret' });
  eq(sig.opts.method, 'post');
  ok(env.call('adminOverrideLine', { adminId: 'p1', gameId: 'g1', favorite: 'Away1', spread: 7 }).ok);
  ok(env.call('postMessage', { playerId: 'p2', type: 'general', message: 'hi' }).ok);
  eq(staleSignals().length, 3, 'admin write and chat post each signal once');
});

test('front door: triggers and hand edits signal straight away (no web request to wait for)', () => {
  const env = loadBackend(); const { kickoff } = seedLeague(env, { kickoffOffset: -3600000 }); enableFrontDoor(env);
  env.ctx.onSheetChange({});
  ok(staleSignals().length >= 1, 'hand edit');
  const n = staleSignals().length;
  espnEvents = [];
  for (let i = 1; i <= 10; i++) espnEvents.push(mkEvent('E' + i, 'Away' + i, 'Home' + i, { date: kickoff, homeScore: 7, awayScore: 3 }));
  env.props.lastAutoScoreFetch = '0';
  env.ctx.keepWarm();
  ok(staleSignals().length > n, 'live score fetch on the keepWarm trigger');
});

test('front door: a failing Worker never breaks the request', () => {
  const env = loadBackend(); seedLeague(env); enableFrontDoor(env);
  const orig = env.ctx.UrlFetchApp.fetch;
  env.ctx.UrlFetchApp.fetch = (url, opts) => { if (String(url).indexOf('frontdoor') >= 0) throw new Error('DNS failure'); return orig(url, opts); };
  const r = env.call('submitPicks', picksPayload('p2', { gameId: 'g1', pickedTeam: 'Away1' }));
  ok(r.ok, r.error);
});

// The owner checks what's pasted in the Apps Script editor by its first line.
test('line 1 of every backend .gs file shows the current CODE_VERSION', () => {
  const dir = path.join(__dirname, '..', 'backend');
  const code = fs.readFileSync(path.join(dir, 'Code.gs'), 'utf8');
  const v = (code.match(/var CODE_VERSION = '([^']+)'/) || [])[1];
  ok(v, 'CODE_VERSION not found');
  fs.readdirSync(dir).filter(f => f.endsWith('.gs')).forEach(f => {
    const first = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)[0];
    ok(first.startsWith('// ' + v + ' '), f + ' line 1 should start with "// ' + v + '" but is: ' + first);
  });
});

// ---------------------------------------------------------------- phase 3: safe pick-save retries
test('a repeated submitPicks (same player + requestId) gets the first answer back and saves NOTHING', () => {
  const env = loadBackend(); seedLeague(env);
  const first = env.call('submitPicks', Object.assign(straightOnly('p2', [1, 2, 3]), { requestId: 'req-A1' }));
  ok(first.ok, first.error); eq(first.missing, 7);
  // the resend carries the same id -- even if its body somehow differed, nothing is written
  const again = env.call('submitPicks', Object.assign(straightOnly('p2', [4, 5], 'Away'), { requestId: 'req-A1' }));
  eq(again.missing, first.missing, 'same answer as the first save');
  const mine = rowsOf(env, 'Picks').filter(p => p.playerId === 'p2');
  eq(mine.map(p => p.gameId).sort(), ['g1', 'g2', 'g3'], 'the repeat changed nothing');
});

test('a NEW requestId (the player tapping Save again) saves normally; ids never cross players', () => {
  const env = loadBackend(); seedLeague(env);
  ok(env.call('submitPicks', Object.assign(straightOnly('p2', [1]), { requestId: 'same-id' })).ok);
  ok(env.call('submitPicks', Object.assign(straightOnly('p2', [2]), { requestId: 'next-id' })).ok);
  eq(rowsOf(env, 'Picks').filter(p => p.playerId === 'p2').length, 2);
  ok(env.call('submitPicks', Object.assign(straightOnly('p3', [1]), { requestId: 'same-id' })).ok);
  eq(rowsOf(env, 'Picks').filter(p => p.playerId === 'p3').length, 1, 'p3 is not answered with p2\'s save');
});

test('submitPicks without a requestId (old app copies) works exactly as before; junk ids are ignored', () => {
  const env = loadBackend(); seedLeague(env);
  ok(env.call('submitPicks', straightOnly('p2', [1])).ok);
  ok(env.call('submitPicks', Object.assign(straightOnly('p2', [2]), { requestId: 'bad id with spaces' })).ok);
  ok(env.call('submitPicks', Object.assign(straightOnly('p2', [3]), { requestId: 'bad id with spaces' })).ok);
  eq(rowsOf(env, 'Picks').filter(p => p.playerId === 'p2').length, 3, 'an invalid id is treated as no id');
});

// ---------------------------------------------------------------- v17: lean triggers + chat
test('chat: with the state cached, posting/reading/reporting reads neither Players (avatars) nor Season; pushes unchanged', () => {
  const env = loadBackend(); seedLeague(env); enablePush(env);
  const pl = env.ss.getSheetByName('Players'); const h = pl._data[0];
  pl._data.forEach((row, i) => { if (i && row[h.indexOf('id')] === 'p3') row[h.indexOf('chatNotif')] = 'off'; });
  env.ctx.invalidateStateCache();
  env.call('getState'); // the app (or keepWarm) has the state cached
  if (!env.ss.getSheetByName('PerfLog')) env.ss.insertSheet('PerfLog').appendRow(['timestamp', 'action', 'ms', 'ok', 'error', 'reason', 'notes']);
  const reads = countSheetReads(env);
  env.ctx._sheetDataCache = {};
  const before = pushes().length;
  const r = env.call('postMessage', { playerId: 'p2', type: 'general', message: 'hello' });
  ok(r.ok, r.error);
  eq(pushes().slice(before).map(m => m.token).sort(), ['tok0a', 'tok0b'], 'p1 only: not the poster, not p3 (chat off)');
  const m = env.call('getMessages', { type: 'general' });
  eq(m.messages.map(x => [x.message, x.teamName, String(x.season)]), [['hello', 'TEAM2', '2026']], 'new message visible at once');
  ok(env.call('logClientError', { failedAction: 'getState', message: 'x', playerId: 'p2' }).ok);
  ok(/TEAM2/.test(env.ss.getSheetByName('PerfLog')._data.find(x => x[1] === 'client:getState')[6]), 'team still recorded');
  eq([reads.Players, reads.Season], [undefined, undefined], JSON.stringify(reads));
  // a non-member still can't post, and only admins use the commissioner channel
  eq(env.call('postMessage', { playerId: 'nobody', message: 'x' }).ok, false);
  eq(env.call('postMessage', { playerId: 'p2', type: 'commissioner', message: 'x' }).ok, false);
  const b2 = pushes().length;
  ok(env.call('postMessage', { playerId: 'p1', type: 'commissioner', message: 'league news' }).ok);
  eq(pushes().length - b2, 6, 'commissioner post still reaches every device');
});

test('final-score check: "nothing new" is answered from the cached state -- no sheet reads, no script lock', () => {
  const env = loadBackend(); const { kickoff } = seedLeague(env); enablePush(env);
  finishWeek(env, kickoff, 10);
  env.call('getState'); // cache now holds the finals
  let locks = 0;
  const gl = env.ctx.LockService.getScriptLock;
  env.ctx.LockService.getScriptLock = () => { locks++; return gl(); };
  env.ctx._sheetDataCache = {};
  env.ctx.checkGameFinalNotifications();
  const n = pushes().length;
  ok(n > 0 && locks === 1, 'new finals: full run (lock + pushes)');
  ok(rowsOf(env, 'UpsetHistory').length > 0, 'week wrapped up');
  env.call('getState');
  const reads = countSheetReads(env);
  env.ctx._sheetDataCache = {};
  env.ctx.checkGameFinalNotifications();
  eq([reads.Games, reads.Season, locks, pushes().length], [undefined, undefined, 1, n], 'quiet run: nothing read, locked or sent');
  // without a cached state it falls back to the sheets (and still sends nothing twice)
  env.ctx.invalidateStateCache();
  env.ctx._sheetDataCache = {};
  env.ctx.checkGameFinalNotifications();
  eq([reads.Games > 0, pushes().length], [true, n]);
});

test('front door: a live-score keepWarm sends exactly ONE stale signal, after its cache rebuild', () => {
  const env = loadBackend(); const { kickoff } = seedLeague(env, { kickoffOffset: -3600000 }); enableFrontDoor(env);
  env.call('submitPicks', straightOnly('p2', [1, 2])); // p3 has no picks -> auto defaults get written too
  espnEvents = [];
  for (let i = 1; i <= 10; i++) espnEvents.push(mkEvent('E' + i, 'Away' + i, 'Home' + i, { date: kickoff, homeScore: 7, awayScore: 3 }));
  env.props.lastAutoScoreFetch = '0';
  const n = staleSignals().length;
  let warmAtSignal = null;
  const f = env.ctx.UrlFetchApp.fetch;
  env.ctx.UrlFetchApp.fetch = (url, opts) => { if (String(url).indexOf('frontdoor') >= 0) warmAtSignal = !!env.cache.get('appState_v3_n'); return f(url, opts); };
  env.ctx.keepWarm();
  ok(Number(env.props.lastAutoScoreFetch) > Date.now() - 60000, 'scores were fetched');
  eq(staleSignals().length - n, 1, 'one signal for the whole run');
  eq(warmAtSignal, true, 'sent after the state was rebuilt');
  env.ctx.keepWarm(); // nothing changed since -> no signal
  eq(staleSignals().length - n, 1);
  // a web request inside is unaffected: still one signal per write
  ok(env.call('adminOverrideLine', { adminId: 'p1', gameId: 'g1', favorite: 'Away1', spread: 7 }).ok);
  eq(staleSignals().length - n, 2);
});

test('game summary: ESPN fetched once per game while cached (60s live, 6h final); failures are not cached', () => {
  const env = loadBackend(); seedLeague(env);
  const ttls = {};
  const put = env.cache.put;
  env.cache.put = (k, v, ttl) => { ttls[k] = ttl; return put(k, v, ttl); };
  const summaryFetches = () => fetchLog.filter(c => c.url.indexOf('summary?event=') >= 0).length;
  const a = env.call('getGameSummary', { espnEventId: '401', awayTeam: 'A', homeTeam: 'B' });
  const b = env.call('getGameSummary', { espnEventId: '401', awayTeam: 'A', homeTeam: 'B' });
  ok(a.ok && b.ok, a.error || b.error);
  eq(summaryFetches(), 1, 'second viewer served from cache');
  eq(Object.keys(a).sort(), ['_version', 'boxscore', 'leaders', 'ok', 'recap', 'scoringPlays', 'situation', 'winProbability'], 'same reply shape');
  eq(JSON.stringify(b), JSON.stringify(a));
  eq(ttls.gamesummary_v1_401, 60, 'live game');
  const f = env.ctx.UrlFetchApp.fetch;
  env.ctx.UrlFetchApp.fetch = (url, opts) => String(url).indexOf('event=402') >= 0
    ? { getResponseCode: () => 200, getContentText: () => JSON.stringify({ header: { competitions: [{ status: { type: { completed: true, detail: 'Final' } } }] } }) }
    : f(url, opts);
  ok(env.call('getGameSummary', { espnEventId: '402' }).ok);
  eq(ttls.gamesummary_v1_402, 21600, 'final game');
  env.ctx.UrlFetchApp.fetch = () => ({ getResponseCode: () => 503, getContentText: () => '' });
  eq(env.call('getGameSummary', { espnEventId: '403' }).ok, false);
  eq(env.cache.get('gamesummary_v1_403'), null, 'an ESPN error is not cached');
});

test('diagnostics: PerfLog rows carry the code version; the report splits THIS version\'s keepWarm/getState numbers', () => {
  const env = loadBackend(); seedLeague(env);
  env.cache.remove('perfLogRecent');
  env.ctx._perfNotes = { keepWarm: 'fresh' };
  env.ctx.logPerf_('keepWarm', 4500, { ok: true });
  const pl = env.ss.getSheetByName('PerfLog');
  const v = env.ctx.CODE_VERSION;
  eq(JSON.parse(pl._data[pl._data.length - 1][6]), { v, keepWarm: 'fresh' });
  const now = new Date().toISOString();
  pl.appendRow([now, 'keepWarm', 9000, true, '', 'slow', JSON.stringify({ v, keepWarm: 'rebuilt' })]);
  pl.appendRow([now, 'keepWarm', 7000, true, '', 'slow', JSON.stringify({ v: 'v1-old', keepWarm: 'rebuilt' })]);
  pl.appendRow([now, 'getState', 5000, true, '', 'slow', JSON.stringify({ v, stateCache: 'hit', picksCache: 'miss' })]);
  pl.appendRow([now, 'getState', 6000, true, '', 'slow', '']); // logged before versions were recorded
  const rep = env.ctx.runDiagnostics();
  const cur = {}; rep.perfCurrent.forEach(p => { cur[p.action] = [p.logged, p.p50]; });
  eq(cur['keepWarm [fresh]'], [1, 4500]);
  eq(cur['keepWarm [rebuilt]'], [1, 9000], 'the old version\'s row is left out');
  eq(cur['getState [state hit, picks miss]'], [1, 5000]);
  ok(rep.perf.find(p => p.action === 'keepWarm').logged >= 3, '7-day totals still include every row');
  const s = env.call('getDiagnosticsSummary').summary;
  ok(s.perfCurrent.length >= 3 && s.perfCurrentSince, 'in the summary');
});

// ---------------------------------------------------------------- report
let failed = 0;
results.forEach(([pass, name, err]) => {
  console.log((pass ? '  PASS  ' : '  FAIL  ') + name + (err ? '\n    ' + err : ''));
  if (!pass) failed++;
});
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);
