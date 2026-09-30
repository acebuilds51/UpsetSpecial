// v20-hall-games-sep30  (Notifications.gs -- the backend version this copy belongs to; must equal CODE_VERSION in Code.gs)
// ============================================================
//  UPSET SPECIAL — Notifications & week/season finalization (v2, Sep 2026)
//
//  Lives alongside Code.gs in the same Apps Script project and uses its helpers
//  (sheetToObjects, getSeasonConfig, computeCoveringTeam_, computeRegularStandings,
//  archivePerfectWeeks_, sendFcmBatch_, ...).
//
//  What changed from v1:
//   - No credentials in code. Push uses Code.gs's sendFcmBatch_, which reads the
//     service account from Script Property FCM_SERVICE_ACCOUNT_JSON, caches the
//     OAuth token, and sends in parallel (v1 did a fresh token exchange + a serial
//     request for EVERY push).
//   - Straight picks are scored AGAINST THE ORIGINAL (frozen) SPREAD everywhere —
//     push "X/Y correct", UpsetHistory, and the season-end CareerHistory archive —
//     exactly like the standings. v1 used the outright winner.
//   - Upset Specials on games outside the 10-game board now count in UpsetHistory
//     and the season archive (v1 only looked at board games).
//   - Perfect weeks are recorded ONLY by archivePerfectWeeks_ in Code.gs
//     (v1 appended its own, un-deduplicated copies).
//   - checkPickReminders removed: pick reminders are Code.gs's 3-hour and
//     90-minute push + email (scheduled automatically by Post Week).
//   - apiRegisterFcmToken removed (a second copy of the Code.gs endpoint —
//     whichever file loaded last silently won).
//   - checkGameFinalNotifications exits after reading only Season + Games unless
//     there is actually something new to announce.
//
//  Triggers: run installNotificationTriggers() once (safe to re-run).
// ============================================================

var APP_URL = 'https://acebuilds51.github.io/UpsetSpecial';

function installNotificationTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    var fn = t.getHandlerFunction();
    if (fn === 'checkPickReminders' || fn === 'checkGameFinalNotifications' || fn === 'autoFinalizeSeasonIfComplete') {
      ScriptApp.deleteTrigger(t);
    }
  });
  // final-score pushes + week wrap-up — every 5 minutes (cheap when nothing is new)
  ScriptApp.newTrigger('checkGameFinalNotifications').timeBased().everyMinutes(5).create();
  // season finalization — every Monday morning
  ScriptApp.newTrigger('autoFinalizeSeasonIfComplete').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(6).create();
  Logger.log('Notification triggers installed (checkPickReminders retired — Code.gs sends the 3h/90min reminders).');
}

// Retired. Kept only so an old trigger pointing here removes itself instead of
// sending duplicate reminders or failing every 15 minutes.
function checkPickReminders() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'checkPickReminders') ScriptApp.deleteTrigger(t);
  });
  Logger.log('checkPickReminders is retired; its trigger has been removed.');
}

// Active players' push tokens (one entry per device), with their score preference.
function getNotifyTargets_() {
  var targets = [];
  playersLite_().forEach(function(p) { // cached list: no avatars read
    if (!(p.active === true || p.active === 'TRUE')) return;
    String(p.fcmToken || '').split(',').map(function(t) { return t.trim(); }).filter(Boolean).forEach(function(token) {
      targets.push({ playerId: p.id, token: token, scorePref: String(p.scoreNotif || 'each') }); // 'each' | 'summary' | 'off'
    });
  });
  return targets;
}

// Outright result (for the "UPSET!" label and Upset Special hits): 'TIE' on a tie.
function outrightWinner_(g) {
  var a = Number(g.finalAwayScore) || 0, h = Number(g.finalHomeScore) || 0;
  return a > h ? g.awayTeam : (h > a ? g.homeTeam : 'TIE');
}
function underdogOf_(g) { return g.favorite === g.homeTeam ? g.awayTeam : g.homeTeam; }
function isTrue_(v) { return v === true || v === 'TRUE'; }

// ---- Final-score pushes + week wrap-up (trigger: every 5 minutes) ----
function checkGameFinalNotifications() { runWithOneStaleSignal_(checkGameFinalNotifications_); }

function checkGameFinalNotifications_() {
  // The common case (nothing new) is answered from the cached state -- no sheet reads and
  // no script lock, which pick saves wait on. This runs 288 times a day next to keepWarm;
  // it used to take the lock and read Season + Games every time. Every score fetch and
  // every write busts that cache, so a cached "nothing new" is current. Anything that
  // might be new (or no cache) goes on to the full check below, which reads the sheets.
  if (!finalNotificationsMayHaveWork_(cachedSharedStateOrNull_())) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return; // another run (or a pick submission) is busy — next tick will catch up
  try {
    var props = PropertiesService.getScriptProperties();
    var work = finalNotificationWork_(getSeasonConfig(), sheetToObjects(SHEET_NAMES.GAMES), props);
    if (!work) return; // nothing new -- done after 2 sheet reads
    var week = work.week, boardGames = work.boardGames, notified = work.notified;
    var newFinals = work.newFinals, needsWrapUp = work.needsWrapUp;
    var notifiedKey = work.notifiedKey, summaryKey = work.summaryKey;

    var targets = getNotifyTargets_();

    if (newFinals.length) {
      var weekPicks = sheetToObjects(SHEET_NAMES.PICKS).filter(function(p) {
        return Number(p.week) === week && !isTrue_(p.isUpset);
      });
      var messages = [];
      newFinals.forEach(function(g) {
        var covering = computeCoveringTeam_(g); // against the frozen spread — same as standings
        var winner = outrightWinner_(g);
        var isUpset = winner !== 'TIE' && winner === underdogOf_(g);
        var gamePicks = weekPicks.filter(function(p) { return p.gameId === g.gameId; });
        var correct = gamePicks.filter(function(p) { return String(p.pickedTeam) === covering; }).length;

        var title = '🏁 Final' + (isUpset ? ' 🚨' : '') + ': ' + g.awayTeam + ' @ ' + g.homeTeam;
        var body = g.awayTeam + ' ' + (Number(g.finalAwayScore) || 0) + ', ' + g.homeTeam + ' ' + (Number(g.finalHomeScore) || 0) +
          (isUpset ? ' 🚨 UPSET!' : '') +
          (gamePicks.length ? ' ' + covering + ' covered — ' + correct + '/' + gamePicks.length + ' players correct.' : '');
        targets.forEach(function(t) {
          if (t.scorePref === 'each') messages.push({ token: t.token, title: title, body: body, data: pushData_('final', 'final-' + g.gameId, 'scores') });
        });
        notified[g.gameId] = true;
      });
      sendFcmBatch_(messages);
      props.setProperty(notifiedKey, JSON.stringify(notified));
    }

    if (needsWrapUp) {
      var lines = boardGames.map(function(g) {
        var w = outrightWinner_(g);
        return g.awayTeam + ' ' + (Number(g.finalAwayScore) || 0) + '-' + (Number(g.finalHomeScore) || 0) + ' ' + g.homeTeam +
          (w !== 'TIE' && w === underdogOf_(g) ? ' 🚨' : '');
      });
      sendFcmBatch_(targets.filter(function(t) { return t.scorePref === 'summary'; }).map(function(t) {
        return { token: t.token, title: '📊 Week ' + week + ' — Final Scores', body: lines.join('\n'), data: pushData_('summary', 'summary-' + week, 'standings') };
      }));
      props.setProperty(summaryKey, 'true');

      try { updateUpsetHistoryForWeek(week); } catch (e) { Logger.log('UpsetHistory update error: ' + e.message); }
      try { archivePerfectWeeks_(week); } catch (e) { Logger.log('Perfect week archive error: ' + e.message); }
    }
  } finally {
    releaseLock_(lock);
  }
}

// What checkGameFinalNotifications has to do for the current week, or null if nothing:
// { week, boardGames, notified, notifiedKey, newFinals, summaryKey, needsWrapUp }.
// cfg = season config object; games = every Games row (from the sheet or the cached state).
function finalNotificationWork_(cfg, games, props) {
  var week = Number(cfg.currentWeek || 0);
  var year = Number(cfg.year || new Date().getFullYear());
  var boardGames = (games || []).filter(function(g) {
    return Number(g.week) === week && g.source !== 'external';
  });
  if (boardGames.length === 0) return null;

  // Keys include the year (v1's 'summary_sent_week1' would have silently blocked
  // next season's week-1 wrap-up). Falls back to the old key so this week isn't re-sent.
  var notifiedKey = 'score_notified_' + year + '_week' + week;
  var notified = JSON.parse(props.getProperty(notifiedKey) || props.getProperty('score_notified_week' + week) || '{}');
  var newFinals = boardGames.filter(function(g) { return isTrue_(g.isFinal) && !notified[g.gameId]; });
  var summaryKey = 'summary_sent_' + year + '_week' + week;
  var summaryAlreadySent = props.getProperty(summaryKey) ||
    (year === 2026 && props.getProperty('summary_sent_week' + week)); // pre-v2 key, this season only
  var allFinal = boardGames.every(function(g) { return isTrue_(g.isFinal); });
  var needsWrapUp = allFinal && !summaryAlreadySent;
  if (newFinals.length === 0 && !needsWrapUp) return null;
  return { week: week, boardGames: boardGames, notified: notified, notifiedKey: notifiedKey,
    newFinals: newFinals, summaryKey: summaryKey, needsWrapUp: needsWrapUp };
}

// Quick pre-check from the cached state (null = no cache: assume there may be work).
function finalNotificationsMayHaveWork_(shared) {
  if (!shared) return true;
  var cfg = {};
  (shared.season || []).forEach(function(r) { cfg[r.key] = r.value; });
  return !!finalNotificationWork_(cfg, shared.games, PropertiesService.getScriptProperties());
}

// ---- Rebuild one week's UpsetHistory rows (called when all board games are final) ----
// Straight picks are scored against the frozen spread; the Upset Special counts
// whether it was on a board game or any other game (source 'external').
function updateUpsetHistoryForWeek(week) {
  week = Number(week);
  var ss = getSS();
  var year = Number(getSeasonConfig().year || new Date().getFullYear());

  var weekFinals = sheetToObjects(SHEET_NAMES.GAMES).filter(function(g) {
    return Number(g.week) === week && isTrue_(g.isFinal);
  });
  var boardFinals = weekFinals.filter(function(g) { return g.source !== 'external'; });
  if (boardFinals.length === 0) return;
  var gameById = {};
  weekFinals.forEach(function(g) { gameById[g.gameId] = g; });

  var players = sheetToObjects(SHEET_NAMES.PLAYERS).filter(function(p) { return isTrue_(p.active); });
  var weekPicks = sheetToObjects(SHEET_NAMES.PICKS).filter(function(p) { return Number(p.week) === week; });
  var norm = function(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim(); };

  var batchRows = players.map(function(player) {
    var mine = weekPicks.filter(function(pk) { return pk.playerId === player.id; });
    var correctCount = 0;
    mine.forEach(function(pk) {
      if (isTrue_(pk.isUpset)) return;
      var g = gameById[pk.gameId];
      if (g && g.source !== 'external' && String(pk.pickedTeam) === computeCoveringTeam_(g)) correctCount++;
    });
    var upsetPick = mine.filter(function(pk) { return isTrue_(pk.isUpset); })[0];
    var upsetGame = upsetPick ? gameById[upsetPick.gameId] : null;
    var hit = false, upsetPts = 0;
    if (upsetGame) {
      var w = outrightWinner_(upsetGame);
      hit = w !== 'TIE' && w === underdogOf_(upsetGame) && String(upsetPick.pickedTeam) === w;
      if (hit) upsetPts = Number(upsetGame.spread) || 0;
    }
    var totalGames = boardFinals.length;
    // who the Upset Special played and the final score (Upset Hall of Fame)
    var dogIsHome = upsetGame && String(upsetPick.pickedTeam) === String(upsetGame.homeTeam);
    var opponent = upsetGame ? (dogIsHome ? upsetGame.awayTeam : upsetGame.homeTeam) : '';
    var dogScore = upsetGame ? Number(dogIsHome ? upsetGame.finalHomeScore : upsetGame.finalAwayScore) || 0 : '';
    var oppScore = upsetGame ? Number(dogIsHome ? upsetGame.finalAwayScore : upsetGame.finalHomeScore) || 0 : '';
    return [
      year, week, norm(player.teamName || player.name),
      upsetPick ? String(upsetPick.pickedTeam || '') : '',
      upsetGame ? (Number(upsetGame.spread) || 0) : 0,
      correctCount + upsetPts,
      !!upsetPick, hit, upsetPts,
      correctCount, totalGames, correctCount === totalGames && week > 0,
      opponent, dogScore, oppScore
    ];
  });

  var uh = ss.getSheetByName('UpsetHistory');
  if (!uh) {
    uh = ss.insertSheet('UpsetHistory');
    uh.appendRow(UPSET_HISTORY_COLUMNS);
  }
  // one read + one write: keep every row except this year+week, then append the new ones
  var data = uh.getDataRange().getValues();
  var headers = data[0];
  // Rows are always written in UPSET_HISTORY_COLUMNS order -- label any unnamed trailing
  // columns so correctCount / ... / oppScore are readable by name.
  var FULL = UPSET_HISTORY_COLUMNS;
  for (var hi = 0; hi < FULL.length; hi++) { if (!headers[hi]) headers[hi] = FULL[hi]; }
  var yI = headers.indexOf('year'), wI = headers.indexOf('week');
  var keep = data.filter(function(r, i) { return i === 0 || !(Number(r[yI]) === year && Number(r[wI]) === week); });
  var width = Math.max(headers.length, FULL.length);
  var out = keep.concat(batchRows).map(function(r) { r = r.slice(0, width); while (r.length < width) r.push(''); return r; });
  uh.getRange(1, 1, Math.max(data.length, out.length), width).clearContent();
  uh.getRange(1, 1, out.length, width).setValues(out);
  // flush first: the Trophy Room caches a summary of this tab for hours, and a visit
  // between the bust and the end of this run would otherwise re-cache the old rows
  SpreadsheetApp.flush();
  invalidateSheetCache('UpsetHistory');
  Logger.log('UpsetHistory updated for ' + year + ' Week ' + week + ': ' + batchRows.length + ' players');
}

// ---- ONE-TIME REPAIR (run from the editor after deploying v2) ----
// Rebuilds this season's UpsetHistory for every fully-final week using against-the-
// spread scoring (v1 wrote them by outright winner), records any missing perfect
// weeks, and LISTS (never deletes) this season's PerfectWeeks rows that don't pass
// the against-the-spread rule so the commissioner can decide what to remove.
function repairThisSeasonHistory() {
  var year = Number(getSeasonConfig().year || new Date().getFullYear());
  var games = sheetToObjects(SHEET_NAMES.GAMES).filter(function(g) { return Number(g.week) >= 1 && g.source !== 'external'; });
  var weeks = {};
  games.forEach(function(g) { (weeks[Number(g.week)] = weeks[Number(g.week)] || []).push(g); });
  Object.keys(weeks).map(Number).sort(function(a, b) { return a - b; }).forEach(function(wk) {
    if (!weeks[wk].every(function(g) { return isTrue_(g.isFinal); })) return;
    _sheetDataCache = {};
    updateUpsetHistoryForWeek(wk);
    archivePerfectWeeks_(wk);
  });
  _sheetDataCache = {};
  var valid = {};
  sheetToObjects('UpsetHistory').forEach(function(r) {
    if (Number(r.year) === year && isTrue_(r.isPerfect)) valid[String(r.teamName) + '|' + Number(r.week)] = true;
  });
  var norm = function(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim(); };
  var playersById = {};
  sheetToObjects(SHEET_NAMES.PLAYERS).forEach(function(p) { playersById[p.id] = p; });
  var suspect = sheetToObjects(SHEET_NAMES.PERFECT_WEEKS).filter(function(r) {
    if (Number(r.year) !== year) return false;
    var p = playersById[r.playerId];
    var team = norm(p ? (p.teamName || p.name) : r.teamName);
    return !valid[team + '|' + Number(r.week)];
  });
  Logger.log('UpsetHistory rebuilt for every completed ' + year + ' week.');
  Logger.log(suspect.length ? ('PerfectWeeks rows for ' + year + ' that are NOT perfect against the spread (review and delete by hand if wrong):\n' +
    suspect.map(function(r) { return '  row ' + r._row + ': ' + r.teamName + ' week ' + r.week; }).join('\n')) : 'All ' + year + ' PerfectWeeks rows check out.');
}

// ---- Season finalization (trigger: Mondays 6am) ----
function autoFinalizeSeasonIfComplete() {
  var props = PropertiesService.getScriptProperties();
  var year = Number(getSeasonConfig().year || new Date().getFullYear());
  var finalizedKey = 'season_finalized_' + year;
  if (props.getProperty(finalizedKey)) return;

  var now = new Date();
  var month = now.getMonth() + 1, day = now.getDate();
  // v1 used `month >= 2`, which is also true all through Sep-Dec -- so any Monday
  // during the season where every game so far was final could "finalize" the season
  // early (writing partial-season CareerHistory rows and setting the flag that blocks
  // the real finalization). Only late January through July counts as post-bowls.
  var isAfterBowls = (month === 1 && day >= 20) || (month >= 2 && month <= 7);
  if (!isAfterBowls) return;

  var seasonGames = sheetToObjects(SHEET_NAMES.GAMES).filter(function(g) { return Number(g.week) >= 1; });
  if (seasonGames.length === 0) return;
  if (!seasonGames.every(function(g) { return isTrue_(g.isFinal); })) return;

  Logger.log('Auto-finalizing season ' + year);
  try {
    updateCareerHistoryForSeason(year);
    var weeks = {};
    seasonGames.forEach(function(g) { weeks[Number(g.week)] = true; });
    Object.keys(weeks).forEach(function(wk) { updateUpsetHistoryForWeek(Number(wk)); });
    archivePerfectWeeks_(null);
    props.setProperty(finalizedKey, new Date().toISOString());
    Logger.log('Season ' + year + ' finalized successfully');
  } catch (e) {
    Logger.log('Auto-finalization error: ' + e.message);
  }
}

// ---- Write a completed season's totals to CareerHistory ----
// Uses computeRegularStandings() — the exact numbers shown in the app's standings —
// so the permanent record can never disagree with the final standings.
function updateCareerHistoryForSeason(year) {
  year = Number(year);
  var ss = getSS();
  var activeIds = {};
  sheetToObjects(SHEET_NAMES.PLAYERS).forEach(function(p) { if (isTrue_(p.active)) activeIds[p.id] = true; });
  var standings = computeRegularStandings().filter(function(s) { return activeIds[s.playerId]; });

  var ch = ss.getSheetByName('CareerHistory');
  if (!ch) {
    ch = ss.insertSheet('CareerHistory');
    ch.appendRow(['playerId','name','teamName','year','points','matched']);
  }
  var data = ch.getDataRange().getValues();
  var yI = data[0].indexOf('year');
  var keep = data.filter(function(r, i) { return i === 0 || Number(r[yI]) !== year; });
  var width = data[0].length;
  var rows = standings.map(function(s) {
    var r = [s.playerId, s.name, s.teamName, year, s.points, 'YES'];
    while (r.length < width) r.push('');
    return r.slice(0, width);
  });
  var out = keep.concat(rows);
  ch.getRange(1, 1, Math.max(data.length, out.length), width).clearContent();
  ch.getRange(1, 1, out.length, width).setValues(out);
  invalidateSheetCache('CareerHistory');
  invalidateCareerHistoryCache();
  Logger.log('CareerHistory updated for ' + year + ': ' + rows.length + ' players');
}
