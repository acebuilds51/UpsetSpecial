// Builds tools/.harness/index.html: a copy of index.html with a fake backend injected
// at the top of <head>, so the real frontend can be exercised in a browser without
// touching the live league. The fake counts every API call in window.__apiCalls.
//
// Usage: node tools/make-frontend-harness.js   then open tools/.harness/index.html
// Query params: ?session=1 (log in as a fake player), ?fail=1 (backend always errors),
//               ?delay=ms (simulate a slow backend),
//               ?final=1 (week 1 is over: final scores + picks, TESTERS perfect, 2-way tie for top score),
//               ?unposted=1 (week 1 board not posted yet; two games are missing a kickoff / spread)
// Admin writes that matter for the Pot tab (adminTogglePaid, adminLedgerEntry, adminLedgerBatch)
// update the fake state, so the next getState shows them.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const outDir = path.join(__dirname, '.harness');
fs.mkdirSync(outDir, { recursive: true });

const mock = `<script>
(function(){
  var qs = new URLSearchParams(location.search);
  var delay = Number(qs.get('delay') || 150);
  window.__apiCalls = [];
  if (qs.get('session') === '1' && !localStorage.getItem('usl_player')) {
    localStorage.setItem('usl_player', JSON.stringify({ id: 'p1', name: 'Test Admin', teamName: 'TESTERS', isAdmin: true, active: true }));
  }
  var kickoff = new Date(Date.now() + 2 * 86400000).toISOString();
  var games = [];
  for (var i = 1; i <= 10; i++) games.push({ week: 1, gameId: 'g' + i, espnEventId: 'E' + i, awayTeam: 'Away ' + i, homeTeam: 'Home ' + i, favorite: 'Home ' + i, spread: 3.5, source: 'espn', kickoff: kickoff, locked: true, isFinal: false, finalAwayScore: '', finalHomeScore: '' });
  var picks = [];
  if (qs.get('final') === '1') {
    kickoff = new Date(Date.now() - 2 * 86400000).toISOString();
    games.forEach(function(g, i) { g.kickoff = kickoff; g.isFinal = true; g.finalHomeScore = 30; g.finalAwayScore = 20; }); // home covers 3.5 everywhere
    // p1 and p2: every home team (10/10, perfect) + a missed upset -> tied at 10 pts. p3: 6 picks -> 6 pts.
    ['p1', 'p2'].forEach(function(pid) {
      games.forEach(function(g) { picks.push({ week: 1, playerId: pid, gameId: g.gameId, pickedTeam: g.homeTeam, isUpset: false }); });
      picks.push({ week: 1, playerId: pid, gameId: 'g10', pickedTeam: 'Away 10', isUpset: true });
    });
    games.slice(0, 6).forEach(function(g) { picks.push({ week: 1, playerId: 'p3', gameId: g.gameId, pickedTeam: g.homeTeam, isUpset: false }); });
  }
  if (qs.get('unposted') === '1') { games.forEach(function(g) { g.locked = false; }); games[2].kickoff = ''; games[6].spread = ''; }
  var state = { ok: true, players: [{ id: 'p1', name: 'Test Admin', teamName: 'TESTERS', isAdmin: true, active: true }, { id: 'p2', name: 'Pat', teamName: 'PATS', isAdmin: false, active: true }, { id: 'p3', name: 'Sam', teamName: 'SAMS', isAdmin: false, active: true }],
    season: [{ key: 'year', value: 2026 }, { key: 'currentWeek', value: 1 }, { key: 'leagueName', value: 'Upset Special League' }, { key: 'entryFee', value: 100 }, { key: 'weeklyPrize', value: 100 }, { key: 'perfectWeekBonus', value: 100 }],
    rotation: [{ week: 1, playerId: 'p2', status: qs.get('unposted') === '1' ? 'submitted' : 'posted', assignedAt: '' }], games: games, picks: picks, ledger: [], bowlGames: [], bowlPicks: [], bowlChampion: [], bowlLedger: [], snapshotCount: 0 };
  var draft = null;
  var realFetch = window.fetch.bind(window);
  window.fetch = function(url, opts) {
    if (String(url).indexOf('script.google.com') < 0) return realFetch(url, opts);
    var body = {}; try { body = JSON.parse(opts && opts.body || '{}'); } catch (e) {}
    window.__apiCalls.push({ action: body.action, t: Math.round(performance.now()) });
    return new Promise(function(resolve, reject) {
      setTimeout(function() {
        if (qs.get('fail') === '1') return resolve(new Response('<html>Service unavailable</html>', { status: 503 }));
        var data = { ok: true };
        if (body.action === 'getState') data = state;
        else if (body.action === 'getCareerHistory') data = { ok: true, history: [] };
        else if (body.action === 'getAvatars') data = { ok: true, avatars: {} };
        else if (body.action === 'getMessages') data = { ok: true, messages: [] };
        else if (body.action === 'getAllTimeLeaderboard') data = { ok: true, leaderboard: [] };
        else if (body.action === 'getAllEspnScores') data = { ok: true, games: [] };
        else if (body.action === 'getTrophyRoom') data = { ok: true };
        else if (body.action === 'adminTogglePaid') state.players.forEach(function(p) { if (p.id === body.playerId) p.isPaid = body.isPaid; });
        else if (body.action === 'adminLedgerEntry') state.ledger.push({ playerId: body.playerId, season: 2026, type: body.type, amount: body.amount, note: body.note || '', date: new Date().toISOString() });
        else if (body.action === 'adminLedgerBatch') {
          (body.entries || []).forEach(function(e) { state.ledger.push({ playerId: e.playerId, season: 2026, type: e.type, amount: e.amount, note: e.note, date: new Date().toISOString() }); });
          data = { ok: true, recorded: (body.entries || []).length, skipped: 0 };
        }
        else if (body.action === 'adminGenerateResultsEmail') {
          draft = { ok: true, week: body.week, title: 'Week ' + body.week + ' Results', subtitle: 'Fake', bodyHtml: '<p>Fake recap</p>', verified: false, validationIssues: ['Fake issue'], attempts: 3, generatedAt: new Date().toISOString(), stats: { games: 10, players: 3, upsetHits: 0, perfectWeeks: 2 } };
          data = draft;
        }
        else if (body.action === 'adminGetResultsDraft') data = { ok: true, draft: draft && draft.week === body.week ? draft : null };
        else if (body.action === 'adminSendCustomEmail') {
          if (!body.testOnly && body.recapWeek != null) state.season.push({ key: 'recapSentWeeks', value: 'y2026:' + body.recapWeek });
          data = { ok: true, sent: 3, quotaLeft: 97 };
        }
        resolve(new Response(JSON.stringify(data), { status: 200 }));
      }, delay);
    });
  };
})();
</script>`;

let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
html = html.replace(/<head([^>]*)>/i, m => m + '\n' + mock);
fs.writeFileSync(path.join(outDir, 'index.html'), html);
console.log('Wrote ' + path.join(outDir, 'index.html'));
