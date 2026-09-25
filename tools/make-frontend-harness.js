// Builds tools/.harness/index.html: a copy of index.html with a fake backend injected
// at the top of <head>, so the real frontend can be exercised in a browser without
// touching the live league. The fake counts every API call in window.__apiCalls.
//
// Usage: node tools/make-frontend-harness.js   then open tools/.harness/index.html
// Query params: ?session=1 (log in as a fake player), ?fail=1 (backend always errors),
//               ?delay=ms (simulate a slow backend)
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
  var state = { ok: true, players: [{ id: 'p1', name: 'Test Admin', teamName: 'TESTERS', isAdmin: true, active: true }, { id: 'p2', name: 'Pat', teamName: 'PATS', isAdmin: false, active: true }],
    season: [{ key: 'year', value: 2026 }, { key: 'currentWeek', value: 1 }, { key: 'leagueName', value: 'Upset Special League' }, { key: 'entryFee', value: 100 }],
    rotation: [], games: games, picks: [], ledger: [], bowlGames: [], bowlPicks: [], bowlChampion: [], bowlLedger: [], snapshotCount: 0 };
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
