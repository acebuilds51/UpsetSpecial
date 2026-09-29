/**
 * UPSET SPECIAL LEAGUE — Backend v2 (Google Apps Script)
 * --------------------------------------------------------
 * Bound to a Google Sheet that acts as the database. Deploy as a Web App
 * (Execute as: Me, Access: Anyone) and paste the /exec URL into the
 * front-end's CONFIG.API_URL.
 *
 * SHEETS (auto-created by ensureSheets()):
 *   Players      | id, name, teamName, pin, isAdmin, active, joinedSeason, careerPoints
 *   Season       | key, value
 *   Rotation     | week, playerId, status, assignedAt
 *   Games        | week, gameId, espnEventId, awayTeam, homeTeam, favorite, spread, source,
 *                  kickoff, locked, finalAwayScore, finalHomeScore, isFinal, postedAt
 *   Picks        | week, playerId, gameId, pickedTeam, isUpset, isAutoDefault, submittedAt
 *   Ledger       | playerId, season, type, amount, note, date
 *   BowlGames    | phase, slot, gameId, espnEventId, awayTeam, homeTeam, favorite, spread,
 *                  source, kickoff, locked, finalAwayScore, finalHomeScore, isFinal, postedAt
 *                  (phase: 'round1' | 'quarter' | 'semi')
 *   BowlPicks    | phase, playerId, gameId, pickedTeam, isUpset, isAutoDefault, submittedAt
 *   BowlChampion | playerId, teamPicked, isAutoDefault, submittedAt
 *   BowlLedger   | playerId, season, type, amount, note, date
 *
 * All endpoints go through doGet/doPost using an `action` parameter.
 *
 * NOTE (Aug 16 2026 session): registration now grants immediate login access.
 * `active` still means "counts as a full league member" (standings, rotation
 * eligibility, ledger, leaderboards, the admin pending-badge count) exactly as
 * before -- it just no longer blocks login. A pending player can log in, look
 * around, and submit picks; they simply won't appear in active-only lists
 * until an admin approves them via apiAdminApprovePlayer, which flips
 * active to true and fires an approval email (+ push, if they already have
 * an FCM token on file).
 */

const SHEET_NAMES = {
  MESSAGES: 'Messages',
  UPSET_HISTORY: 'UpsetHistory',
  PERFECT_WEEKS: 'PerfectWeeks',
  BIOS: 'Bios',
  PLAYERS: 'Players',
  SEASON: 'Season',
  ROTATION: 'Rotation',
  GAMES: 'Games',
  PICKS: 'Picks',
  LEDGER: 'Ledger',
  LINE_SNAPSHOT: 'LineSnapshot',
  BOWL_GAMES: 'BowlGames',
  BOWL_PICKS: 'BowlPicks',
  BOWL_CHAMPION: 'BowlChampion',
  BOWL_LEDGER: 'BowlLedger',
  BOWL_WINNERS: 'BowlWinners',
  NAME_CLAIMS: 'NameClaims',
  SEASON_TROPHIES: 'SeasonTrophies'
};

const HEADERS = {
  Messages: ['messageId', 'type', 'playerId', 'playerName', 'teamName', 'message', 'postedAt', 'season'],
  UpsetHistory: ['year', 'week', 'teamName', 'upsetPick', 'spread', 'weekPts', 'attempted', 'hit', 'upsetPts'],
  Bios: ['playerId', 'teamName', 'hometown', 'college', 'favTeam', 'firstGame', 'favGame', 'favPlayer', 'favUpset', 'strategy', 'occupation', 'funFact', 'email', 'bioText', 'photoUrl', 'updatedAt'],
  Season: ['key', 'value'],
  Rotation: ['week', 'playerId', 'status', 'assignedAt'],
  Games: ['week', 'gameId', 'espnEventId', 'awayTeam', 'homeTeam', 'favorite', 'spread', 'source', 'kickoff', 'locked', 'finalAwayScore', 'finalHomeScore', 'isFinal', 'postedAt', 'homeLogo', 'awayLogo'],
  Picks: ['week', 'playerId', 'gameId', 'pickedTeam', 'isUpset', 'isAutoDefault', 'submittedAt'],
  Ledger: ['playerId', 'season', 'type', 'amount', 'note', 'date'],
  // LineSnapshot stores every college football game's opening line, snapshotted
  // automatically when the admin posts the weekly board. Upset special picks use
  // this frozen line regardless of when the player makes their pick during the week.
  LineSnapshot: ['week', 'espnEventId', 'awayTeam', 'homeTeam', 'favorite', 'spread', 'kickoff', 'homeLogo', 'awayLogo', 'snapshotAt'],
  BowlGames: ['phase', 'slot', 'gameId', 'espnEventId', 'awayTeam', 'homeTeam', 'favorite', 'spread', 'source', 'kickoff', 'locked', 'finalAwayScore', 'finalHomeScore', 'isFinal', 'postedAt', 'homeLogo', 'awayLogo'],
  BowlPicks: ['phase', 'playerId', 'gameId', 'pickedTeam', 'isUpset', 'isAutoDefault', 'submittedAt'],
  BowlChampion: ['playerId', 'teamPicked', 'isAutoDefault', 'submittedAt'],
  BowlLedger: ['playerId', 'season', 'type', 'amount', 'note', 'date'],
  BowlWinners: ['playerId', 'name', 'teamName', 'year', 'position', 'points'],
  NameClaims: ['claimId', 'playerId', 'playerName', 'currentTeamName', 'claimedTeamName', 'reason', 'status', 'submittedAt', 'reviewedAt', 'reviewedBy'],
  SeasonTrophies: ['playerId', 'teamName', 'year', 'position', 'points', 'archivedAt'],
  // Players never had a HEADERS entry before (a long-standing gap — it's why appendObject
  // used to crash on registration). Listing it properly now, and adding installedAt so
  // reconcileHeaders appends that column automatically once schemaVersion bumps below.
  Players: ['id', 'name', 'teamName', 'pin', 'isAdmin', 'active', 'joinedSeason', 'careerPoints', 'email', 'venmo', 'paypal', 'avatar', 'paymentPref', 'fcmToken', 'scoreNotif', 'isPaid', 'chatNotif', 'referredBy', 'installedAt', 'deactivatedAt']
};

const POINT_VALUES = { round1: 1, quarter: 3, semi: 4, champion: 5 };

// Bumped whenever the deployed Code.gs changes in a way you need to be able to
// verify from a live response (added tonight to debug a deployment propagation
// issue). Every API response includes this as `_version` -- if it's ever
// missing or stale on a live response, the deployment isn't running current code.
var CODE_VERSION = 'v16-safe-pick-retry-sep29';

// Actions that never change anything in the cached state (players, season, rotation,
// games, bowl games/champion/ledger). Every OTHER action busts the state cache on
// success. When adding a new endpoint: if it only reads, add it here.
// (submitPicks is handled inside the endpoint -- picks aren't cached.)
var READ_ONLY_ACTIONS = {
  login: 1, getState: 1, getAllTimeLeaderboard: 1, getAllEspnScores: 1, getMessages: 1,
  postMessage: 1, deleteMessage: 1, getTrophyRoom: 1, saveBio: 1, generateBio: 1, helpChat: 1,
  getMyNameClaims: 1, getClaimableNames: 1, submitNameClaim: 1, adminAuditCareerHistory: 1,
  adminGetNameClaims: 1, getCareerHistory: 1, getAvatars: 1, getGameSummary: 1,
  adminGetPending: 1, getWeeklyEspnSlate: 1, getPickerSlateFromSnapshot: 1,
  searchEspnGames: 1, searchSnapshotGames: 1, fetchEspnGamesByDateRange: 1,
  getStandings: 1, getBowlStandings: 1, adminListEmailTemplates: 1, adminGetEmailTemplate: 1, logClientError: 1, getDiagnosticsSummary: 1,
  adminPreviewCustomEmail: 1, adminGenerateResultsEmail: 1, adminGetResultsDraft: 1, adminSendTemplateEmail: 1,
  adminSendCustomEmail: 1, registerFcmToken: 0 /* fcmToken is in the cached player list */
};

// ---------- ENTRY POINTS ----------

function doGet(e) { return handle(e); }
function doPost(e) { return handle(e); }

function handle(e) {
  var t0 = Date.now();
  // Reset request-scoped caches for each new request
  _ssCache = null;
  _sheetDataCache = {};
  _perfNotes = {};
  _picksDirty = false;
  _inWebRequest = true;
  _frontDoorDirty = false;

  let action = (e.parameter && e.parameter.action) || '';
  let payload = {};
  try {
    if (e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
      action = payload.action || action;
    }
  } catch (err) { /* fall back to query params */ }

  // The app only ever POSTs. Record what GET requests ask for (action + parameter
  // NAMES only, no values) so getDiagnosticsSummary can show who else is calling --
  // e.g. an unknown caller hitting doGet every 60s around the clock (Sep 2026).
  if (!(e.postData && e.postData.contents)) noteGetRequest_(e);

  // Requests with no action at all come from bots / link previews / someone opening
  // the URL -- never the app. Answer immediately: no sheet work, no PerfLog row
  // (they were showing up as ~70 "Unknown action" errors a week in diagnostics).
  if (!action) {
    _inWebRequest = false;
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'No action.', _version: CODE_VERSION }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  ensureSheets();

  let result;
  try {
    switch (action) {
      case 'login': result = apiLogin(payload); break;
      case 'getState': result = apiGetState(payload); break;
      case 'getAllTimeLeaderboard': result = apiGetAllTimeLeaderboard(); break;
      case 'getAllEspnScores': result = apiGetAllEspnScores(payload); break;
      case 'adminTogglePaid': result = apiAdminTogglePaid(payload); break;
      case 'getMessages': result = apiGetMessages(payload); break;
      case 'postMessage': result = apiPostMessage(payload); break;
      case 'deleteMessage': result = apiDeleteMessage(payload); break;
      case 'getTrophyRoom': result = apiGetTrophyRoom(payload); break;
      case 'adminRecordBowlWinners': result = apiAdminRecordBowlWinners(payload); break;
      case 'saveBio': result = apiSaveBio(payload); break;
      case 'generateBio': result = apiGenerateBio(payload); break;
      case 'helpChat':    result = apiHelpChat(payload);    break;
      case 'adminFixCareerMapping': result = apiAdminFixCareerMapping(payload); break;
      case 'submitNameClaim': result = apiSubmitNameClaim(payload); break;
      case 'getMyNameClaims': result = apiGetMyNameClaims(payload); break;
      case 'getClaimableNames': result = apiGetClaimableNames(payload); break;
      case 'adminAuditCareerHistory': result = apiAdminAuditCareerHistory(); break;
      case 'adminReviewNameClaim': result = apiAdminReviewNameClaim(payload); break;
      case 'adminGetNameClaims': result = apiAdminGetNameClaims(payload); break;
      case 'getCareerHistory': result = apiGetCareerHistory(); break;
      case 'updateTeamName': result = apiUpdateTeamName(payload); break;
      case 'markAppInstalled': result = apiMarkAppInstalled(payload); break;
      case 'getAvatars': result = apiGetAvatars(payload); break;
      case 'getGameSummary': result = apiGetGameSummary(payload); break;

      // admin: players / season
      case 'adminAddPlayer': result = apiAdminAddPlayer(payload); break;
      case 'registerPlayer': result = apiRegisterPlayer(payload); break;
      case 'adminGetPending': result = apiAdminGetPending(payload); break;
      case 'adminApprovePlayer': result = apiAdminApprovePlayer(payload); break;
      case 'adminUpdatePlayer': result = apiAdminUpdatePlayer(payload); break;
      case 'adminSetSeason': result = apiAdminSetSeason(payload); break;

      // regular season: rotation / slate / lines / picks / results
      case 'adminAssignPicker': result = apiAdminAssignPicker(payload); break;
      case 'adminRandomPicker': result = apiAdminRandomPicker(payload); break;
      case 'submitSlate': result = apiSubmitSlate(payload); break;
      case 'getWeeklyEspnSlate': result = apiGetWeeklyEspnSlate(payload); break;
      case 'getPickerSlateFromSnapshot': result = apiGetPickerSlateFromSnapshot(payload); break;
      case 'adminFetchEspnLines': result = apiAdminFetchEspnLines(payload); break;
      case 'adminPostWeek': result = apiAdminPostWeek(payload); break;
      case 'adminClearWeek': result = apiAdminClearWeek(payload); break;
      case 'changePin': result = apiChangePin(payload); break;
      case 'updateProfile': result = apiUpdateProfile(payload); break;
      case 'registerFcmToken': result = apiRegisterFcmToken(payload); break;
      case 'adminOverrideLine': result = apiAdminOverrideLine(payload); break;
      case 'searchEspnGames': result = apiSearchEspnGames(payload); break;
      case 'searchSnapshotGames': result = apiSearchSnapshotGames(payload); break;
      case 'adminRefreshSnapshot': result = apiAdminRefreshSnapshot(payload); break;
      case 'fetchEspnGamesByDateRange': result = apiFetchEspnGamesByDateRange(payload); break;
      case 'submitPicks': result = apiSubmitPicks(payload); break;
      case 'adminFetchResults': result = apiAdminFetchResults(payload); break;
      case 'adminOverrideResult': result = apiAdminOverrideResult(payload); break;
      case 'adminApplyNoPickDefaults': result = apiAdminApplyNoPickDefaults(payload); break;
      case 'adminArchivePerfectWeeks': result = apiAdminArchivePerfectWeeks(payload); break;
      case 'adminArchiveSeasonTrophies': result = apiAdminArchiveSeasonTrophies(payload); break;
      case 'adminListEmailTemplates': result = apiAdminListEmailTemplates(payload); break;
      case 'adminGetEmailTemplate': result = apiAdminGetEmailTemplate(payload); break;
      case 'adminSendTemplateEmail': result = apiAdminSendTemplateEmail(payload); break;
      case 'adminSendCustomEmail': result = apiAdminSendCustomEmail(payload); break;
      case 'adminPreviewCustomEmail': result = apiAdminPreviewCustomEmail(payload); break;
      case 'adminGenerateResultsEmail': result = apiAdminGenerateResultsEmail(payload); break;
      case 'adminClearSeasonTrophies': result = apiAdminClearSeasonTrophies(payload); break;
      case 'adminLedgerEntry': result = apiAdminLedgerEntry(payload); break;
      case 'adminLedgerBatch': result = apiAdminLedgerBatch(payload); break;
      case 'adminGetResultsDraft': result = apiAdminGetResultsDraft(payload); break;
      case 'getStandings': result = apiGetStandings(payload); break;

      // bowl bonanza
      case 'adminSetBowlGames': result = apiAdminSetBowlGames(payload); break;
      case 'adminClearBowlPhase': result = apiAdminClearBowlPhase(payload); break;
      case 'adminFetchBowlEspnLines': result = apiAdminFetchBowlEspnLines(payload); break;
      case 'adminPostBowlPhase': result = apiAdminPostBowlPhase(payload); break;
      case 'adminOverrideBowlLine': result = apiAdminOverrideBowlLine(payload); break;
      case 'submitBowlPicks': result = apiSubmitBowlPicks(payload); break;
      case 'submitBowlChampion': result = apiSubmitBowlChampion(payload); break;
      case 'adminFetchBowlResults': result = apiAdminFetchBowlResults(payload); break;
      case 'adminOverrideBowlResult': result = apiAdminOverrideBowlResult(payload); break;
      case 'adminApplyBowlNoPickDefaults': result = apiAdminApplyBowlNoPickDefaults(payload); break;
      case 'adminBowlLedgerEntry': result = apiAdminBowlLedgerEntry(payload); break;
      case 'getBowlStandings': result = apiGetBowlStandings(payload); break;
      case 'logClientError': result = apiLogClientError(payload); break;
      case 'getDiagnosticsSummary': result = apiGetDiagnosticsSummary(); break;

      default: result = { ok: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { ok: false, error: err.message || String(err) };
  }

  // Any successful write busts the shared state cache. Individual endpoints used to be
  // responsible for this and ~15 of them forgot (line overrides, picker assignment,
  // results, every bowl action...), leaving stale data on screen for minutes. This is
  // what makes the longer cache TTL safe.
  // Writes are buffered until flushed; flush FIRST so a concurrent app load can't
  // re-cache pre-write data right after we bust the cache.
  if (result && result.ok !== false && !READ_ONLY_ACTIONS[action] && action !== 'submitPicks') {
    try { SpreadsheetApp.flush(); } catch (e) {}
    invalidateStateCache();
  } else if (_picksDirty) {
    try { SpreadsheetApp.flush(); } catch (e) {}
    invalidatePicksBundle_();
  }

  // Performance trail (replaces the old DebugLog, which appended a row for EVERY
  // request -- an extra sheet write on every call, and a tab that grew forever and
  // slowed the whole spreadsheet down). Now only slow/failed requests plus a small
  // random sample are recorded, which is what runDiagnostics() summarizes nightly.
  logPerf_(action, Date.now() - t0, result);

  // Anything this request changed makes the Cloudflare front door's copies out of date
  // (writes from app copies that talk to Apps Script directly, getState's own score fetch).
  if (_frontDoorDirty) sendFrontDoorStale_();
  _inWebRequest = false;

  result._version = CODE_VERSION;
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- SETUP ----------

function ensureSheets() {
  // This used to run ~20 spreadsheet metadata calls + a PropertiesService read at the
  // start of EVERY request. Once a run has confirmed everything exists at the current
  // schema version, skip it for 6 hours (a missing sheet would still be re-created by
  // the next run after the flag expires, or immediately via clearEnsureSheetsFlag()).
  const flagKey = 'ensureSheetsOk_' + ENSURE_SHEETS_SCHEMA_VERSION;
  const scriptCache = CacheService.getScriptCache();
  try { if (scriptCache.get(flagKey)) return; } catch (e) {}
  ensureSheetsUncached_();
  try { scriptCache.put(flagKey, '1', 21600); } catch (e) {}
}

function clearEnsureSheetsFlag() {
  CacheService.getScriptCache().remove('ensureSheetsOk_' + ENSURE_SHEETS_SCHEMA_VERSION);
}

var ENSURE_SHEETS_SCHEMA_VERSION = '7'; // bump this string whenever HEADERS schema changes

function ensureSheetsUncached_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // check once whether all sheets exist -- sheet name lookup is fast (metadata only)
  const allExist = Object.keys(HEADERS).every(name => !!ss.getSheetByName(name));

  if (!allExist) {
    // first-time setup: create any missing sheets
    Object.keys(HEADERS).forEach(name => {
      let sheet = ss.getSheetByName(name);
      if (!sheet) {
        sheet = ss.insertSheet(name);
        sheet.appendRow(HEADERS[name]);
        sheet.setFrozenRows(1);
      }
    });
  }

  // header reconciliation (adding new columns like homeLogo/awayLogo) is expensive --
  // it reads every sheet's header row. Only run it once per deployment by caching a
  // flag in ScriptProperties. Clear this property manually (or it auto-clears on next deploy)
  // if you ever add new columns again in the future.
  const props = PropertiesService.getScriptProperties();
  const schemaVersion = ENSURE_SHEETS_SCHEMA_VERSION;
  if (props.getProperty('schemaVersion') !== schemaVersion) {
    Object.keys(HEADERS).forEach(name => {
      const sheet = ss.getSheetByName(name);
      if (sheet) reconcileHeaders(sheet, HEADERS[name]);
    });
    props.setProperty('schemaVersion', schemaVersion);
  }

  const seasonSheet = ss.getSheetByName(SHEET_NAMES.SEASON);
  if (seasonSheet && seasonSheet.getLastRow() < 2) {
    const defaults = [
      ['year', new Date().getFullYear()],
      ['leagueName', 'Upset Special League'],
      ['currentWeek', 1],
      ['entryFee', 100],
      ['weeklyPrize', 100],
      ['seasonPayout1stPct', 36.5],
      ['seasonPayout2ndPct', 17],
      ['seasonPayout3rdPct', 10],
      ['bowlEntryFee', 25],
      ['bowlCurrentPhase', 'round1']
    ];
    defaults.forEach(row => seasonSheet.appendRow(row));
  }
  const playersSheet = ss.getSheetByName(SHEET_NAMES.PLAYERS);
  if (playersSheet && playersSheet.getLastRow() < 2) {
    playersSheet.appendRow(['p1', 'Jeff Wilkerson', 'VOLZ', '1111', true, true, new Date().getFullYear(), 0]);
  }
}

// if a sheet already exists but the code's schema has grown new columns since it was created
// (e.g. adding logo URLs), append the missing header(s) to the end of the existing header row.
// Never reorders or removes existing columns, so old data stays intact and correctly aligned.
function reconcileHeaders(sheet, expectedHeaders) {
  const lastCol = sheet.getLastColumn();
  const currentHeaders = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  const missing = expectedHeaders.filter(h => !currentHeaders.includes(h));
  if (missing.length > 0) {
    sheet.getRange(1, currentHeaders.length + 1, 1, missing.length).setValues([missing]);
  }
}

// ---------- GENERIC HELPERS ----------

// Request-scoped spreadsheet cache — avoids repeated getActiveSpreadsheet() calls
var _ssCache = null;
function getSS() { if (!_ssCache) _ssCache = SpreadsheetApp.getActiveSpreadsheet(); return _ssCache; }
function getSheet(name) { return getSS().getSheetByName(name); }

// Request-scoped sheet data cache — each sheet read only once per request
var _sheetDataCache = {};
function sheetToObjects(sheetName) {
  if (_sheetDataCache[sheetName]) return _sheetDataCache[sheetName];
  const sheet = getSheet(sheetName);
  if (!sheet) return [];
  const range = sheet.getDataRange().getValues();
  const headers = range[0];
  const rows = range.slice(1);
  const result = rows
    .map((row, idx) => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = row[i]);
      obj._row = idx + 2;
      return obj;
    })
    .filter(obj => obj[headers[0]] !== '' && obj[headers[0]] !== undefined && obj[headers[0]] !== null);
  _sheetDataCache[sheetName] = result;
  return result;
}

// Call after any write to invalidate the per-request cache for that sheet. Every
// write helper below calls this, so it is also where the cross-request picks cache
// (getState's picks/ledger/bowlPicks) learns that those tabs changed.
var PICKS_BUNDLE_SHEETS = { Picks: 1, Ledger: 1, BowlPicks: 1 };
function invalidateSheetCache(sheetName) {
  delete _sheetDataCache[sheetName];
  if (PICKS_BUNDLE_SHEETS[sheetName]) invalidatePicksBundle_();
  if (sheetName === SHEET_NAMES.UPSET_HISTORY) invalidateUpsetHistoryIndex_();
}

// Reads the sheet's LIVE header row rather than trusting the hardcoded HEADERS
// object -- this is what fixes the "Cannot read properties of undefined (reading
// 'map')" crash that happened whenever a sheet (like Players) had no matching
// entry in HEADERS at all. Falls back to HEADERS only for a genuinely brand-new
// empty sheet that has no header row yet.
function appendObject(sheetName, obj) {
  const sheet = getSheet(sheetName);
  const lastCol = sheet.getLastColumn();
  const headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : (HEADERS[sheetName] || []);
  const row = headers.map(h => (obj[h] !== undefined ? obj[h] : ''));
  sheet.appendRow(row);
  // Only the cross-request picks cache is busted here; the request-scoped sheet
  // cache is deliberately left alone (loops that read-then-append would otherwise
  // re-read the whole sheet every pass).
  if (PICKS_BUNDLE_SHEETS[sheetName]) invalidatePicksBundle_();
  return obj;
}

// Batch version of appendObject: ONE header read + ONE setValues for any number of
// rows. Looping appendObject costs ~3 spreadsheet calls per row, so appending a few
// hundred auto-default picks used to take minutes. Same column mapping as appendObject.
function appendObjects_(sheetName, objs) {
  if (!objs || objs.length === 0) return;
  const sheet = getSheet(sheetName);
  const lastCol = sheet.getLastColumn();
  const headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : (HEADERS[sheetName] || []);
  const rows = objs.map(obj => headers.map(h => (obj[h] !== undefined ? obj[h] : '')));
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  invalidateSheetCache(sheetName);
}

// Batch version of updateRowByMatch: reads the sheet ONCE, applies every
// { match, updates } pair in memory, and writes back only the rows that changed
// (one setValues per changed row -- never a block write, so rows this call didn't
// touch can't be clobbered by a concurrent writer).
// Looping updateRowByMatch re-read the ENTIRE sheet for every single update.
// Like updateRowByMatch, each matcher updates only the FIRST matching row.
// Returns the number of rows updated.
function updateRowsByMatchBatch_(sheetName, changes) {
  if (!changes || changes.length === 0) return 0;
  const sheet = getSheet(sheetName);
  const range = sheet.getDataRange().getValues();
  if (range.length < 2) return 0;
  const sheetHeaders = range[0].map(function(h) { return String(h).trim(); });
  const rowObjs = [];
  for (let i = 1; i < range.length; i++) {
    const rowObj = {};
    sheetHeaders.forEach((h, idx) => rowObj[h] = range[i][idx]);
    rowObjs.push(rowObj);
  }
  const dirty = {};
  changes.forEach(function(ch) {
    for (let i = 0; i < rowObjs.length; i++) {
      if (ch.match(rowObjs[i])) {
        Object.keys(ch.updates).forEach(function(key) {
          const colIdx = sheetHeaders.indexOf(key);
          if (colIdx >= 0) { range[i + 1][colIdx] = ch.updates[key]; rowObjs[i][key] = ch.updates[key]; }
        });
        dirty[i + 1] = true;
        return;
      }
    }
  });
  const dirtyRows = Object.keys(dirty).map(Number).sort((a, b) => a - b);
  if (dirtyRows.length === 0) return 0;
  dirtyRows.forEach(function(r) { sheet.getRange(r + 1, 1, 1, sheetHeaders.length).setValues([range[r]]); });
  invalidateSheetCache(sheetName);
  return dirtyRows.length;
}

function updateRowByMatch(sheetName, matchFn, updates) {
  const sheet = getSheet(sheetName);
  const range = sheet.getDataRange().getValues();
  const sheetHeaders = range[0].map(function(h) { return String(h).trim(); });
  // IMPORTANT: always build rowObj from the sheet's REAL live header order, never
  // from the HEADERS schema list. range[i]'s values are physically ordered per
  // sheetHeaders regardless of what HEADERS claims — using a HEADERS entry here
  // (when its order doesn't exactly match the live sheet) silently breaks matching.
  for (let i = 1; i < range.length; i++) {
    const rowObj = {};
    sheetHeaders.forEach((h, idx) => rowObj[h] = range[i][idx]);
    if (matchFn(rowObj)) {
      // Batch all updates into the row array and write in ONE setValues call
      const updatedRow = range[i].slice();
      Object.keys(updates).forEach(key => {
        const colIdx = sheetHeaders.indexOf(key);
        if (colIdx >= 0) updatedRow[colIdx] = updates[key];
      });
      sheet.getRange(i + 1, 1, 1, updatedRow.length).setValues([updatedRow]);
      // Invalidate request-scope cache for this sheet so subsequent reads see the update
      invalidateSheetCache(sheetName);
      return true;
    }
  }
  return false;
}

function deleteRowsByMatch(sheetName, matchFn) {
  const sheet = getSheet(sheetName);
  const rows = sheetToObjects(sheetName).filter(matchFn).map(o => o._row).sort((a, b) => b - a);
  // Delete runs of consecutive rows with one deleteRows() call each (bottom-up, so
  // earlier row numbers stay valid). Same rows removed as the old one-deleteRow-per-row
  // loop, but a player's week of picks -- appended together -- is usually ONE call.
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1] === rows[j] - 1) j++;
    sheet.deleteRows(rows[j], j - i + 1);
    i = j + 1;
  }
  if (rows.length) invalidateSheetCache(sheetName);
}

// Fast bulk-delete for operations that may remove MANY rows at once (e.g.
// clearing an entire week's worth of picks -- potentially hundreds of rows
// across 50+ players). deleteRowsByMatch calls sheet.deleteRow() once per
// matching row, which is fine for a handful of rows but can take a minute or
// more at this scale. This rewrites the sheet's data region in a single
// getValues/setValues pair instead -- one API round trip regardless of how
// many rows are removed.
function deleteRowsByMatchFast_(sheetName, matchFn) {
  const sheet = getSheet(sheetName);
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return; // header row only, or empty
  const headers = data[0].map(function(h) { return String(h).trim(); });
  const keptRows = data.slice(1).filter(function(row) {
    const obj = {};
    headers.forEach(function(h, i) { obj[h] = row[i]; });
    return !matchFn(obj);
  });
  const totalDataRows = data.length - 1;
  sheet.getRange(2, 1, totalDataRows, headers.length).clearContent();
  if (keptRows.length > 0) {
    sheet.getRange(2, 1, keptRows.length, headers.length).setValues(keptRows);
  }
  invalidateSheetCache(sheetName); // later reads in this request must not see deleted rows
}

function genId(prefix) { return prefix + '_' + Utilities.getUuid().split('-')[0]; }

function getSeasonConfig() {
  const rows = sheetToObjects(SHEET_NAMES.SEASON);
  const cfg = {};
  rows.forEach(r => cfg[r.key] = r.value);
  return cfg;
}

function setSeasonConfig(key, value) {
  const found = updateRowByMatch(SHEET_NAMES.SEASON, r => r.key === key, { value: value });
  if (!found) appendObject(SHEET_NAMES.SEASON, { key: key, value: value });
}

function requireAdmin(payload) {
  const players = sheetToObjects(SHEET_NAMES.PLAYERS);
  const player = players.find(p => p.id === payload.adminId);
  if (!player || !player.isAdmin) throw new Error('Admin access required.');
}

// Always release the script lock through this. Sheets buffers writes until the
// execution ends, so without flush() the NEXT request to take the lock can read the
// sheet before our writes land -- defeating the lock (e.g. two copies of the same
// external Upset Special game, or a pick submission overwritten by stale data).
function releaseLock_(lock) {
  try { SpreadsheetApp.flush(); } catch (e) {}
  // Bust the picks cache again now that the writes are really in the sheet: a
  // concurrent app load between our first bust and the flush could have cached
  // the pre-write picks.
  if (_picksDirty) invalidatePicksBundle_();
  lock.releaseLock();
}

// For admin endpoints whose frontend calls historically sent `playerId` rather than
// `adminId` -- accepts either, so backend and frontend can be deployed in any order.
function requireAdminCompat_(payload) {
  requireAdmin({ adminId: payload.adminId || payload.playerId });
}

// ---------- AUTH ----------

// NOTE (Aug 16 2026): no longer blocks login when active is false. `active`
// still means "counts as a full league member" everywhere else in the app
// (standings, rotation, ledger, leaderboards) -- it just doesn't gate login
// anymore, so newly-registered players can log in immediately and see a
// pending-approval banner (frontend) until an admin approves them.
function apiLogin(payload) {
  try {
    const name = (payload.name || '').trim().toLowerCase();
    const pin = String(payload.pin || '').trim();
    const players = sheetToObjects(SHEET_NAMES.PLAYERS);
    const player = players.find(p =>
      (String(p.name).trim().toLowerCase() === name || String(p.teamName).trim().toLowerCase() === name)
      && String(p.pin).trim() === pin
    );
    if (!player) return { ok: false, error: 'Name/team name or PIN not recognized.' };
    return { ok: true, player: { id: player.id, name: player.name, teamName: player.teamName, isAdmin: !!player.isAdmin, active: !!player.active, avatar: player.avatar || '' } };
  } catch(e) {
    Logger.log('apiLogin error: ' + e.message);
    return { ok: false, error: 'Login unavailable — try again in a moment.' };
  }
}

function apiUpdateTeamName(payload) {
  const found = updateRowByMatch(SHEET_NAMES.PLAYERS, r => r.id === payload.playerId, { teamName: payload.teamName });
  return { ok: found };
}

// Records that this player's device successfully installed the app as a PWA.
// Called from two places on the frontend: the browser's `appinstalled` event
// (fires once, at the moment of a fresh install) and an opportunistic check on
// every app boot for anyone already running in standalone mode (covers people
// who installed before this tracking existed). Idempotent — only ever records
// the first timestamp, never overwrites it on a later call.
function apiMarkAppInstalled(payload) {
  var playerId = payload.playerId;
  if (!playerId) return { ok: false, error: 'Missing playerId.' };
  var player = sheetToObjects(SHEET_NAMES.PLAYERS).find(function(p) { return p.id === playerId; });
  if (!player) return { ok: false, error: 'Player not found.' };
  if (player.installedAt) return { ok: true, alreadyRecorded: true };
  updateRowByMatch(SHEET_NAMES.PLAYERS, function(r) { return r.id === playerId; }, { installedAt: new Date().toISOString() });
  return { ok: true };
}

// Batch-fetches full avatars for a given list of player IDs. Deliberately kept
// separate from apiGetState (which is polled frequently in the background) so
// that full-size photo data never bloats the hot path or blows the getState
// cache's 90KB size guard. The frontend calls this once per session/refresh
// cycle and caches the result client-side.
function apiGetAvatars(payload) {
  var ids = Array.isArray(payload.playerIds) ? payload.playerIds : [];
  if (ids.length === 0) return { ok: true, avatars: {} };
  var idSet = {};
  ids.forEach(function(id) { idSet[id] = true; });
  var players = sheetToObjects(SHEET_NAMES.PLAYERS);
  var avatars = {};
  players.forEach(function(p) {
    if (idSet[p.id] && p.avatar) avatars[p.id] = p.avatar;
  });
  return { ok: true, avatars: avatars };
}

// Fetches live in-game detail (down/distance, possession, last play, win
// probability, a few box score stats) for one specific game from ESPN's
// per-event summary endpoint — a separate, richer endpoint from the scoreboard
// used everywhere else. Built defensively: ESPN's exact field names for this
// endpoint haven't been verified against a truly live game yet, so every
// section is wrapped so a missing/renamed field just omits that section
// rather than failing the whole call. Run debugEspnSummary(eventId) with a
// real in-progress game's espnEventId to see the raw shape and confirm/adjust.
function apiGetGameSummary(payload) {
  var espnEventId = payload.espnEventId;
  if (!espnEventId) return { ok: false, error: 'Missing espnEventId.' };

  var url = 'https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=' + espnEventId;
  var resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' }
    });
  } catch (e) {
    return { ok: false, error: 'Fetch failed: ' + e.message };
  }
  if (resp.getResponseCode() !== 200) return { ok: false, error: 'ESPN returned status ' + resp.getResponseCode() };

  var data;
  try { data = JSON.parse(resp.getContentText()); } catch (e) { return { ok: false, error: 'Could not parse ESPN response.' }; }

  var result = { ok: true, situation: null, winProbability: null, boxscore: null, leaders: null, scoringPlays: null, recap: null };

  try {
    var comp = data.header && data.header.competitions && data.header.competitions[0];
    var situation = comp && comp.situation;
    if (situation) {
      result.situation = {
        possessionText: situation.possessionText || situation.shortDownDistanceText || situation.downDistanceText || '',
        lastPlay: (situation.lastPlay && situation.lastPlay.text) || ''
      };
    }
  } catch (e) { Logger.log('getGameSummary situation parse: ' + e.message); }

  try {
    var wp = data.winprobability;
    if (wp && wp.length > 0) {
      var last = wp[wp.length - 1];
      if (typeof last.homeWinPercentage === 'number') {
        result.winProbability = { homePct: Math.round(last.homeWinPercentage * 100) };
      }
    }
  } catch (e) { Logger.log('getGameSummary winprobability parse: ' + e.message); }

  try {
    var teams = data.boxscore && data.boxscore.teams;
    if (teams && teams.length) {
      result.boxscore = teams.map(function(t) {
        var stats = {};
        (t.statistics || []).forEach(function(s) {
          var label = s.label || s.name || s.displayName;
          if (label && s.displayValue !== undefined) stats[label] = s.displayValue;
        });
        return { team: (t.team && (t.team.displayName || t.team.name)) || '', stats: stats };
      });
    }
  } catch (e) { Logger.log('getGameSummary boxscore parse: ' + e.message); }

  // Statistical leaders (top passer/rusher/receiver per team) — real narrative
  // color beyond raw team totals, similar to what ESPN's own gamecast shows.
  try {
    var compLeaders = data.header && data.header.competitions && data.header.competitions[0] && data.header.competitions[0].leaders;
    if (compLeaders && compLeaders.length) {
      result.leaders = compLeaders.map(function(cat) {
        var top = cat.leaders && cat.leaders[0];
        if (!top) return null;
        return {
          category: cat.displayName || cat.name || '',
          player: (top.athlete && top.athlete.displayName) || '',
          team: (top.team && (top.team.displayName || top.team.abbreviation)) || '',
          value: top.displayValue || ''
        };
      }).filter(Boolean);
    }
  } catch (e) { Logger.log('getGameSummary leaders parse: ' + e.message); }

  // Scoring play timeline — what actually happened, in order
  try {
    var scoring = data.scoringPlays;
    if (scoring && scoring.length) {
      result.scoringPlays = scoring.map(function(p) {
        return {
          text: p.text || '',
          period: (p.period && p.period.number) || '',
          clock: (p.clock && p.clock.displayValue) || '',
          awayScore: p.awayScore,
          homeScore: p.homeScore
        };
      });
    }
  } catch (e) { Logger.log('getGameSummary scoringPlays parse: ' + e.message); }

  var isFinal = false;
  var statusDetail = '';
  try {
    var statusType = comp && comp.status && comp.status.type;
    isFinal = !!(statusType && statusType.completed);
    statusDetail = (statusType && statusType.detail) || (statusType && statusType.description) || '';
  } catch (e) { Logger.log('getGameSummary status parse: ' + e.message); }

  // Auto-generate a narrative recap, cached server-side so the AI call happens
  // once per game total, not once per viewer. First person to open this game's
  // detail triggers generation; everyone after gets the cached copy instantly.
  try {
    result.recap = getCachedGameRecap_(
      espnEventId, String(payload.awayTeam || ''), String(payload.homeTeam || ''),
      payload.awayScore, payload.homeScore, result.scoringPlays, result.leaders,
      payload.gameId, String(payload.favorite || ''), payload.spread, isFinal, statusDetail
    );
  } catch (e) { Logger.log('getGameSummary recap: ' + e.message); }

  return result;
}

// Generates (and caches) the narrative recap for one game. Cache key is the
// ESPN event ID, so this is shared across every player who views that game —
// the AI call happens once per game, not once per viewer. 6-hour cache TTL
// (CacheService's max) means a final game's recap effectively only generates
// once; a live game's recap refreshes itself a few times over the course of
// the game as new viewers happen to trigger a regeneration after expiry.
//
// Spread-aware: this league scores straight picks against the spread, not by
// outright winner, so the prompt explicitly tells the AI who actually covered
// — otherwise it defaults to "who won the game" logic, which is wrong here
// (a big favorite winning by less than the spread is a LOSS for anyone who
// picked them, even though their team won on the field).
function getCachedGameRecap_(espnEventId, awayTeam, homeTeam, awayScore, homeScore, scoringPlays, leaders, gameId, favorite, spread, isFinal, statusDetail) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'gamerecap_' + espnEventId;
  var cached = cache.get(cacheKey);
  if (cached) return cached;

  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) return null;

  var scoringText = (scoringPlays || []).map(function(p) {
    return (p.period ? 'Q' + p.period + ' ' : '') + (p.clock || '') + ': ' + p.text;
  }).join('\n');
  var leadersText = (leaders || []).map(function(l) {
    return l.category + ': ' + l.player + ' (' + l.team + ') - ' + l.value;
  }).join('\n');

  var spreadText = '';
  var upsetText = '';
  var haveSpreadInfo = favorite && spread && typeof awayScore === 'number' && typeof homeScore === 'number';
  var underdog = '';
  var favMargin = 0;

  if (haveSpreadInfo) {
    underdog = (favorite === homeTeam) ? awayTeam : homeTeam;
    favMargin = (favorite === homeTeam) ? (homeScore - awayScore) : (awayScore - homeScore);
    var coveringTeam = favMargin > Number(spread) ? favorite : underdog;
    var upsetOccurred = favMargin < 0;
    if (isFinal) {
      spreadText =
        '\nBetting line: ' + favorite + ' favored by ' + spread + ' points.\n' +
        'FINAL RESULT: ' + coveringTeam + ' covered the spread' +
        (upsetOccurred ? ' (won outright as the underdog).' : coveringTeam === favorite ? ' (won by more than ' + spread + ').' : ' (lost by less than ' + spread + ', which still covers).') + '\n' +
        'CRITICAL: this league scores straight picks against the spread, not by who won the game outright. ' +
        'A pick on ' + favorite + ' is a LOSING pick if they did not cover, even though they won the game. ' +
        'Write the recap from this scoring reality, not from "who won" — do not tell people who picked ' + favorite + ' that they should feel good unless ' + favorite + ' actually covered.\n';
    } else {
      // Game is still in progress -- never state a covering team or outcome as
      // settled fact. This is the actual bug fix: previously this branch didn't
      // exist at all, so a halftime score got written up with the exact same
      // definitive, past-tense "covered the spread" language as a final game,
      // which is exactly what caused a still-live game to read as decided.
      spreadText =
        '\nBetting line: ' + favorite + ' favored by ' + spread + ' points.\n' +
        'GAME STATUS: still in progress (' + (statusDetail || 'live') + ') — this is NOT the final result.\n' +
        'CURRENT SNAPSHOT ONLY: if the game ended at this exact score, ' + coveringTeam + ' would be covering the spread' +
        (upsetOccurred ? ' (' + underdog + ' currently winning outright).' : '.') + ' This can completely change before the final whistle.\n' +
        'CRITICAL: do NOT write this recap as if the game is over. Do not say any team "won", "covered", "sent [team] packing", or similar finished-game language. ' +
        'Use present tense and words like "currently", "so far", "at the half/in the Nth quarter" — this is a live update, not a result. ' +
        'Do not declare an Upset Special a hit or a miss below either, since the game hasn\'t finished.\n';
    }

    // Upset Special picks on this specific game, if any — call these players out by name.
    if (gameId) {
      try {
        var picks = sheetToObjects(SHEET_NAMES.PICKS).filter(function(p) {
          return p.gameId === gameId && (p.isUpset === true || p.isUpset === 'TRUE');
        });
        if (picks.length > 0) {
          var players = sheetToObjects(SHEET_NAMES.PLAYERS);
          var names = picks.map(function(p) {
            var pl = players.find(function(x) { return x.id === p.playerId; });
            return pl ? (pl.teamName || pl.name) : null;
          }).filter(Boolean);
          if (names.length > 0) {
            upsetText = isFinal
              ? '\nPlayers who chose ' + underdog + ' as their Upset Special this week: ' + names.join(', ') + '. ' +
                'Their Upset Special ' + (upsetOccurred ? 'HIT' : 'MISSED') + ' (an Upset Special only pays off if the underdog wins outright, not just covers). ' +
                'Give them a brief, warm shoutout by name — congrats if it hit, sympathy if it missed.\n'
              : '\nPlayers who chose ' + underdog + ' as their Upset Special this week: ' + names.join(', ') + '. ' +
                'The game is still in progress, so their Upset Special has NOT hit or missed yet — do not say it did either. ' +
                'A brief, present-tense mention that they\'re riding on this game is fine (e.g. "keep an eye on this one, X and Y").\n';
          }
        }
      } catch (e) { Logger.log('getCachedGameRecap_ upset lookup: ' + e.message); }
    }
  }

  var prompt =
    'Write a short game recap (4-5 sentences) for a fantasy college football pick\'em league, in a warm, ' +
    'slightly irreverent sports-bar voice. Never invent facts -- use only what\'s given below.\n\n' +
    'Score: ' + awayTeam + ' ' + awayScore + ' at ' + homeTeam + ' ' + homeScore + '.\n' +
    (isFinal ? 'This game is FINAL.\n' : 'This game is still IN PROGRESS (' + (statusDetail || 'live') + ') -- NOT final. Write in present tense as a live update, never as a concluded result.\n') +
    spreadText +
    (scoringText ? '\nScoring plays:\n' + scoringText + '\n' : '') +
    (leadersText ? '\nTop performers:\n' + leadersText + '\n' : '') +
    upsetText +
    '\nWrite only the recap paragraph -- no preamble, no quotes, no markdown.';

  try {
    var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 260,
        messages: [{ role: 'user', content: prompt }]
      }),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      Logger.log('getCachedGameRecap_ Anthropic error: ' + resp.getContentText());
      return null;
    }
    var data = JSON.parse(resp.getContentText());
    var text = data.content && data.content[0] && data.content[0].text ? data.content[0].text.trim() : '';
    if (!text) return null;
    cache.put(cacheKey, text, isFinal ? 21600 : 300); // final: 6hr (result never changes). live: 5min (game state does)
    return text;
  } catch (e) {
    Logger.log('getCachedGameRecap_ fetch error: ' + e.message);
    return null;
  }
}

// Run manually from the editor to clear one game's cached recap immediately —
// useful right after a fix to the recap logic, so you can verify the new
// version without waiting up to 6 hours for the old cached copy to expire.
// Find the espnEventId in the Games sheet.
function clearGameRecapCache(espnEventId) {
  CacheService.getScriptCache().remove('gamerecap_' + espnEventId);
  Logger.log('Cleared cached recap for event ' + espnEventId + '. It will regenerate next time anyone views that game\'s detail.');
}

// Convenience wrapper: clear a game's cached recap by team name instead of
// needing to look up its espnEventId manually. Run clearGameRecapByTeams
// below with your two team names filled in, or call this directly.
function clearGameRecapByTeams(teamNameContains) {
  const games = sheetToObjects(SHEET_NAMES.GAMES).filter(function(g) {
    return String(g.awayTeam).toUpperCase().indexOf(teamNameContains.toUpperCase()) !== -1 ||
           String(g.homeTeam).toUpperCase().indexOf(teamNameContains.toUpperCase()) !== -1;
  });
  if (games.length === 0) { Logger.log('No game found matching "' + teamNameContains + '".'); return; }
  games.forEach(function(g) {
    if (!g.espnEventId) { Logger.log(g.awayTeam + ' @ ' + g.homeTeam + ': no espnEventId on file, nothing to clear.'); return; }
    clearGameRecapCache(g.espnEventId);
    Logger.log('(' + g.awayTeam + ' @ ' + g.homeTeam + ')');
  });
}

// Audit: find any player whose CURRENT Upset Special pick is actually the
// favorite, not the underdog. This can only happen for picks submitted before
// the favorite-vs-underdog validation existed -- new submissions are blocked
// from this outright now. Doesn't fix anything, just reports so you can decide
// how to handle each one (message the player to switch if their game hasn't
// started, or just note it since a favorite can never register as an upset hit
// anyway).
function auditInvalidUpsetPicks(week) {
  const players = sheetToObjects(SHEET_NAMES.PLAYERS);
  const games = sheetToObjects(SHEET_NAMES.GAMES);
  const upsetPicks = sheetToObjects(SHEET_NAMES.PICKS).filter(function(p) {
    return Number(p.week) === Number(week) && (p.isUpset === true || p.isUpset === 'TRUE');
  });

  let found = 0;
  upsetPicks.forEach(function(p) {
    const g = games.find(function(gg) { return gg.gameId === p.gameId; });
    if (!g) { Logger.log('Pick references gameId ' + p.gameId + ' with no matching game record.'); return; }
    if (String(g.favorite).trim() !== '' && String(p.pickedTeam) === String(g.favorite)) {
      found++;
      const player = players.find(function(pl) { return pl.id === p.playerId; });
      Logger.log((player ? (player.teamName || player.name) : p.playerId) + ': picked ' + p.pickedTeam +
        ' (the FAVORITE, by ' + g.spread + ') in ' + g.awayTeam + ' @ ' + g.homeTeam + ' -- invalid, submitted ' + p.submittedAt);
    }
  });
  if (found === 0) Logger.log('No invalid (favorite-as-upset) picks found for week ' + week + '.');
  else Logger.log('\n' + found + ' invalid pick(s) found. These can never register as an upset hit regardless -- the favorite winning is never an upset by definition.');
}

// Finds snapshot rows for a week whose kickoff date is way out of line with
// the rest of that week's games -- these are next-week games that got
// mistakenly tagged with this week's number by the date-range bug (now
// fixed). Flags anything more than 4 days from the week's median kickoff.
// Dry run by default; also checks whether any player has actually picked one
// of these as their Upset Special, since that needs separate handling if so.
function findMistaggedNextWeekGames(week, dryRun) {
  if (dryRun === undefined) dryRun = true;
  const rows = sheetToObjects(SHEET_NAMES.LINE_SNAPSHOT).filter(function(r) { return Number(r.week) === Number(week) && r.kickoff; });
  if (rows.length === 0) { Logger.log('No snapshot rows for week ' + week + '.'); return; }

  const times = rows.map(function(r) { return new Date(r.kickoff).getTime(); }).sort(function(a, b) { return a - b; });
  const median = times[Math.floor(times.length / 2)];
  const fourDaysMs = 4 * 24 * 60 * 60 * 1000;

  const outliers = rows.filter(function(r) { return Math.abs(new Date(r.kickoff).getTime() - median) > fourDaysMs; });
  if (outliers.length === 0) { Logger.log('No mistagged games found for week ' + week + '.'); return; }

  Logger.log(outliers.length + ' likely mistagged game(s) found for week ' + week + ' (kickoff far from the week\'s median date):');
  const picks = sheetToObjects(SHEET_NAMES.PICKS).filter(function(p) { return Number(p.week) === Number(week) && (p.isUpset === true || p.isUpset === 'TRUE'); });
  const games = sheetToObjects(SHEET_NAMES.GAMES);
  const players = sheetToObjects(SHEET_NAMES.PLAYERS);

  outliers.forEach(function(r) {
    Logger.log('  ' + r.awayTeam + ' @ ' + r.homeTeam + ' -- kickoff ' + r.kickoff + ' (espnEventId ' + r.espnEventId + ')');
    // check if any player already picked this exact game as their upset (via its Games-sheet row, if one was created)
    const matchingGame = games.find(function(g) { return String(g.espnEventId) === String(r.espnEventId); });
    if (matchingGame) {
      const pickedBy = picks.filter(function(p) { return p.gameId === matchingGame.gameId; });
      pickedBy.forEach(function(p) {
        const player = players.find(function(pl) { return pl.id === p.playerId; });
        Logger.log('    *** ' + (player ? (player.teamName || player.name) : p.playerId) + ' has this picked as their Upset Special -- needs a manual conversation before removing this row. ***');
      });
    }
  });

  if (dryRun) {
    Logger.log('\nDRY RUN -- nothing changed. Run findMistaggedNextWeekGames(' + week + ', false) to remove these rows (only safe once nobody\'s picked them).');
  } else {
    const removeKeys = new Set(outliers.map(function(r) { return String(r.espnEventId); }));
    deleteRowsByMatchFast_(SHEET_NAMES.LINE_SNAPSHOT, function(row) {
      return Number(row.week) === Number(week) && removeKeys.has(String(row.espnEventId));
    });
    invalidateSheetCache(SHEET_NAMES.LINE_SNAPSHOT);
    Logger.log('\nRemoved ' + outliers.length + ' mistagged row(s) from week ' + week + '\'s snapshot.');
  }
}

// Distinguishes a straight pick on a team from an actual Upset Special pick
// on that team -- these are different things, and only the Upset Special
// earns the bonus even if the underdog wins outright. Pass a team name to see
// exactly which of its "pickers" had it as their straight pick only, vs their
// actual Upset Special.
function checkStraightVsUpsetPickers(week, teamNameContains) {
  const players = sheetToObjects(SHEET_NAMES.PLAYERS);
  const games = sheetToObjects(SHEET_NAMES.GAMES);
  const g = games.find(function(gg) {
    return Number(gg.week) === Number(week) &&
      (String(gg.awayTeam).toUpperCase().indexOf(teamNameContains.toUpperCase()) !== -1 ||
       String(gg.homeTeam).toUpperCase().indexOf(teamNameContains.toUpperCase()) !== -1);
  });
  if (!g) { Logger.log('No game found for "' + teamNameContains + '" in week ' + week + '.'); return; }

  const teamFullName = String(g.awayTeam).toUpperCase().indexOf(teamNameContains.toUpperCase()) !== -1 ? g.awayTeam : g.homeTeam;
  Logger.log('Game: ' + g.awayTeam + ' @ ' + g.homeTeam + ' -- checking pickers of ' + teamFullName);

  const picks = sheetToObjects(SHEET_NAMES.PICKS).filter(function(p) {
    return Number(p.week) === Number(week) && p.gameId === g.gameId && p.pickedTeam === teamFullName;
  });

  const straightOnly = picks.filter(function(p) { return !(p.isUpset === true || p.isUpset === 'TRUE'); });
  const asUpset = picks.filter(function(p) { return p.isUpset === true || p.isUpset === 'TRUE'; });

  Logger.log('\n' + straightOnly.length + ' player(s) picked ' + teamFullName + ' as a STRAIGHT pick only (1 pt each for covering, no upset bonus):');
  straightOnly.forEach(function(p) {
    const pl = players.find(function(x) { return x.id === p.playerId; });
    Logger.log('  ' + (pl ? (pl.teamName || pl.name) : p.playerId));
  });

  Logger.log('\n' + asUpset.length + ' player(s) actually had ' + teamFullName + ' as their UPSET SPECIAL (earns the bonus):');
  asUpset.forEach(function(p) {
    const pl = players.find(function(x) { return x.id === p.playerId; });
    Logger.log('  ' + (pl ? (pl.teamName || pl.name) : p.playerId));
  });
}

// One-off: the Apps Script editor's Run button calls a function with no
// arguments, so clearGameRecapCache(espnEventId) alone can't be run directly
// from there. This wrapper has the specific event ID baked in — select this
// function from the dropdown next to Run and click it. Delete this once done.
// Run manually from the editor to find (and optionally fix) players with more
// than one Upset Special pick for a given week -- this can happen if a
// double-tap or slow-network retry raced with itself before the submit
// button was properly disabled and the backend lock was added. Pass
// dryRun=false to actually delete the extra rows, keeping only the most
// recently submitted upset pick per player. Defaults to a dry run (reports
// only, changes nothing) so you can review before fixing.
function findAndFixDuplicateUpsetPicks(week, dryRun) {
  if (dryRun === undefined) dryRun = true;
  const picks = sheetToObjects(SHEET_NAMES.PICKS).filter(function(p) {
    return Number(p.week) === Number(week) && (p.isUpset === true || p.isUpset === 'TRUE');
  });
  const byPlayer = {};
  picks.forEach(function(p) {
    (byPlayer[p.playerId] = byPlayer[p.playerId] || []).push(p);
  });
  const players = sheetToObjects(SHEET_NAMES.PLAYERS);
  const games = sheetToObjects(SHEET_NAMES.GAMES);
  let foundAny = false;
  Object.keys(byPlayer).forEach(function(playerId) {
    const rows = byPlayer[playerId];
    if (rows.length <= 1) return;
    foundAny = true;
    const player = players.find(function(pl) { return pl.id === playerId; });
    const name = player ? (player.teamName || player.name) : playerId;
    Logger.log(name + ' has ' + rows.length + ' upset picks for week ' + week + ':');
    rows.forEach(function(r) {
      const g = games.find(function(gg) { return gg.gameId === r.gameId; });
      const label = g ? (g.awayTeam + ' @ ' + g.homeTeam) : r.gameId;
      Logger.log('  - ' + r.pickedTeam + ' (' + label + ') submitted ' + r.submittedAt + ' [row ' + r._row + ']');
    });
    if (!dryRun) {
      // keep the most recently submitted row, delete the rest
      rows.sort(function(a, b) { return new Date(b.submittedAt) - new Date(a.submittedAt); });
      const toDelete = rows.slice(1).map(function(r) { return r._row; });
      const sheet = getSheet(SHEET_NAMES.PICKS);
      toDelete.sort(function(a, b) { return b - a; }).forEach(function(r) { sheet.deleteRow(r); });
      Logger.log('  -> kept most recent, deleted ' + toDelete.length + ' extra row(s)');
    }
  });
  if (!foundAny) Logger.log('No duplicate upset picks found for week ' + week + '.');
  else if (dryRun) Logger.log('\nDRY RUN -- nothing changed. Run findAndFixDuplicateUpsetPicks(' + week + ', false) to actually fix these.');
  else { SpreadsheetApp.flush(); invalidateStateCache(); } // raw deleteRow calls bypass the helpers -- refresh the app's caches
}

// Broader than findAndFixDuplicateUpsetPicks above -- this checks for ANY
// duplicate pick (straight OR upset) for the same player+game, which is what
// would actually explain a season "correct" count higher than the number of
// games played. Same race condition as the upset-pick duplicates, just not
// caught by the narrower upset-only check. Dry run by default; pass
// dryRun=false to actually delete the extras, keeping each player+game's
// most recently submitted row.
function auditAndFixDuplicatePicks(week, dryRun) {
  if (dryRun === undefined) dryRun = true;
  const picks = sheetToObjects(SHEET_NAMES.PICKS).filter(function(p) {
    return Number(p.week) === Number(week);
  });
  const byPlayerGame = {};
  picks.forEach(function(p) {
    const key = p.playerId + '|' + p.gameId;
    (byPlayerGame[key] = byPlayerGame[key] || []).push(p);
  });
  const players = sheetToObjects(SHEET_NAMES.PLAYERS);
  const games = sheetToObjects(SHEET_NAMES.GAMES);
  let foundAny = false;
  Object.keys(byPlayerGame).forEach(function(key) {
    const rows = byPlayerGame[key];
    if (rows.length <= 1) return;
    // Legitimate, expected case: exactly one straight pick + one upset pick,
    // both on the same team (a player can pick the same underdog to both
    // cover the spread AND win outright -- two different bets on one game).
    if (rows.length === 2) {
      const upsetRows = rows.filter(function(r) { return r.isUpset === true || r.isUpset === 'TRUE'; });
      const straightRows = rows.filter(function(r) { return !(r.isUpset === true || r.isUpset === 'TRUE'); });
      if (upsetRows.length === 1 && straightRows.length === 1 && upsetRows[0].pickedTeam === straightRows[0].pickedTeam) return;
    }
    foundAny = true;
    const player = players.find(function(pl) { return pl.id === rows[0].playerId; });
    const name = player ? (player.teamName || player.name) : rows[0].playerId;
    const g = games.find(function(gg) { return gg.gameId === rows[0].gameId; });
    const label = g ? (g.awayTeam + ' @ ' + g.homeTeam) : rows[0].gameId;
    Logger.log(name + ' has ' + rows.length + ' picks for ' + label + ':');
    rows.forEach(function(r) {
      Logger.log('  - ' + r.pickedTeam + (r.isUpset === true || r.isUpset === 'TRUE' ? ' (upset)' : '') + ' submitted ' + r.submittedAt + ' [row ' + r._row + ']');
    });
    if (!dryRun) {
      rows.sort(function(a, b) { return new Date(b.submittedAt) - new Date(a.submittedAt); });
      const toDelete = rows.slice(1).map(function(r) { return r._row; });
      const sheet = getSheet(SHEET_NAMES.PICKS);
      toDelete.sort(function(a, b) { return b - a; }).forEach(function(r) { sheet.deleteRow(r); });
      Logger.log('  -> kept most recent, deleted ' + toDelete.length + ' extra row(s)');
    }
  });
  if (!foundAny) Logger.log('No duplicate picks found for week ' + week + '.');
  else if (dryRun) Logger.log('\nDRY RUN -- nothing changed. Run auditAndFixDuplicatePicks(' + week + ', false) to actually fix these.');
  else { SpreadsheetApp.flush(); invalidateStateCache(); } // raw deleteRow calls bypass the helpers -- refresh the app's caches
}

// Diagnostic: trace exactly what data exists for a specific player's pick on
// a specific game, and whether it would resolve as an upset hit under the
// current logic. Run diagnosePonytimeUpset() directly from the editor.
function diagnoseUpsetPick(week, playerName, teamPicked) {
  const players = sheetToObjects(SHEET_NAMES.PLAYERS);
  const player = players.find(function(p) {
    return String(p.teamName).toUpperCase() === playerName.toUpperCase() || String(p.name).toUpperCase() === playerName.toUpperCase();
  });
  if (!player) { Logger.log('Player "' + playerName + '" not found.'); return; }
  Logger.log('Player found: id=' + player.id + ', teamName=' + player.teamName);

  const allPicks = sheetToObjects(SHEET_NAMES.PICKS).filter(function(p) {
    return Number(p.week) === Number(week) && p.playerId === player.id;
  });
  Logger.log('\nAll picks for this player, week ' + week + ' (' + allPicks.length + ' total):');
  allPicks.forEach(function(p) {
    Logger.log('  gameId=' + p.gameId + ' pickedTeam=' + p.pickedTeam + ' isUpset=' + p.isUpset + ' isAutoDefault=' + p.isAutoDefault + ' submittedAt=' + p.submittedAt + ' [row ' + p._row + ']');
  });

  const upsetPick = allPicks.find(function(p) {
    return (p.isUpset === true || p.isUpset === 'TRUE') && String(p.pickedTeam).toUpperCase().indexOf(teamPicked.toUpperCase()) !== -1;
  });
  if (!upsetPick) { Logger.log('\nNo upset pick found matching team "' + teamPicked + '".'); return; }
  Logger.log('\nUpset pick found: gameId=' + upsetPick.gameId + ' pickedTeam=' + upsetPick.pickedTeam);

  const allGames = sheetToObjects(SHEET_NAMES.GAMES);
  const game = allGames.find(function(g) { return g.gameId === upsetPick.gameId; });
  if (!game) { Logger.log('\n*** No game record found for gameId ' + upsetPick.gameId + ' at all. ***'); return; }
  Logger.log('\nGame record found:');
  Logger.log('  gameId=' + game.gameId + ' week=' + game.week + ' source=' + game.source);
  Logger.log('  awayTeam=' + game.awayTeam + ' homeTeam=' + game.homeTeam);
  Logger.log('  favorite=' + game.favorite + ' spread=' + game.spread);
  Logger.log('  isFinal=' + game.isFinal + ' finalAwayScore=' + game.finalAwayScore + ' finalHomeScore=' + game.finalHomeScore);

  const isFinal = (game.isFinal === true || game.isFinal === 'TRUE');
  if (!isFinal) { Logger.log('\n*** Game is not marked final -- that is why it is being skipped. Run Fetch Final Scores for this game. ***'); return; }
  const a = Number(game.finalAwayScore) || 0, h = Number(game.finalHomeScore) || 0;
  const winner = a > h ? game.awayTeam : game.homeTeam;
  const dog = (game.favorite === game.homeTeam) ? game.awayTeam : game.homeTeam;
  Logger.log('\nComputed: winner=' + winner + ' underdog=' + dog);
  Logger.log('Picked team matches underdog: ' + (String(upsetPick.pickedTeam) === dog));
  Logger.log('Underdog won: ' + (winner === dog));
  Logger.log('=> Should register as upset HIT: ' + (String(upsetPick.pickedTeam) === dog && winner === dog));
}

// Quick check: print the actual stored final score for a game by team name match.
function checkGameScore(awayOrHomeTeamContains) {
  const games = sheetToObjects(SHEET_NAMES.GAMES).filter(function(g) {
    return String(g.awayTeam).toUpperCase().indexOf(awayOrHomeTeamContains.toUpperCase()) !== -1 ||
           String(g.homeTeam).toUpperCase().indexOf(awayOrHomeTeamContains.toUpperCase()) !== -1;
  });
  if (games.length === 0) { Logger.log('No game found matching "' + awayOrHomeTeamContains + '".'); return; }
  games.forEach(function(g) {
    Logger.log(g.awayTeam + ' ' + g.finalAwayScore + ' at ' + g.homeTeam + ' ' + g.finalHomeScore +
      ' (week ' + g.week + ', favorite: ' + g.favorite + ' by ' + g.spread + ', isFinal: ' + g.isFinal + ')');
  });
}

// Diagnostic: check whether a team appears ANYWHERE in a given week's line
// snapshot -- catches both "the game is genuinely missing from the snapshot"
// and "the game is there but under an unexpected name variant" (e.g. "Arizona
// St" instead of "Arizona State"). Also cross-checks the live ESPN scoreboard
// for that same team, to tell the two cases apart.
function diagnoseSnapshotTeam(week, teamNameContains) {
  const q = teamNameContains.toUpperCase();
  const snapshot = sheetToObjects(SHEET_NAMES.LINE_SNAPSHOT).filter(function(r) { return Number(r.week) === Number(week); });
  Logger.log('Week ' + week + ' snapshot has ' + snapshot.length + ' total game(s).');

  const exactMatches = snapshot.filter(function(r) {
    return String(r.awayTeam).toUpperCase().indexOf(q) !== -1 || String(r.homeTeam).toUpperCase().indexOf(q) !== -1;
  });
  if (exactMatches.length > 0) {
    Logger.log('Found in snapshot matching "' + teamNameContains + '":');
    exactMatches.forEach(function(r) {
      Logger.log('  ' + r.awayTeam + ' @ ' + r.homeTeam + ' (favorite: ' + r.favorite + ' by ' + r.spread + ', kickoff: ' + r.kickoff + ')');
    });
  } else {
    Logger.log('No exact match for "' + teamNameContains + '" in the week ' + week + ' snapshot.');
  }

  // Look for any team name in the snapshot that STARTS WITH the same first
  // word as the query, to surface a likely name-variant mismatch (e.g.
  // searching "Arizona State" but the stored name is "Arizona St").
  const firstWord = teamNameContains.split(' ')[0].toUpperCase();
  const similar = snapshot.filter(function(r) {
    return String(r.awayTeam).toUpperCase().indexOf(firstWord) === 0 || String(r.homeTeam).toUpperCase().indexOf(firstWord) === 0;
  });
  if (similar.length > 0) {
    Logger.log('\nGames in the snapshot starting with "' + firstWord + '" (checking for a name-variant mismatch):');
    similar.forEach(function(r) {
      Logger.log('  ' + r.awayTeam + ' @ ' + r.homeTeam);
    });
  }

  // Cross-check the live ESPN scoreboard for today, to see if the team is
  // playing at all and what ESPN actually calls it.
  try {
    const todayYmd = formatYYYYMMDD(new Date());
    const liveEvents = fetchEspnScoreboard(todayYmd);
    const liveMatch = liveEvents.find(function(ev) {
      const comp = ev.competitions && ev.competitions[0];
      if (!comp) return false;
      const names = (comp.competitors || []).map(function(c) { return String(c.team.displayName || '').toUpperCase(); });
      return names.some(function(n) { return n.indexOf(q) !== -1; });
    });
    if (liveMatch) {
      const comp = liveMatch.competitions[0];
      const home = comp.competitors.find(function(c) { return c.homeAway === 'home'; });
      const away = comp.competitors.find(function(c) { return c.homeAway === 'away'; });
      Logger.log('\nFound on today\'s live ESPN scoreboard: ' + away.team.displayName + ' @ ' + home.team.displayName + ' (ESPN event id: ' + liveMatch.id + ')');
      const line = extractEspnLine(liveMatch, comp, home, away);
      if (line.favorite && line.spread !== '') {
        Logger.log('Line IS posted: ' + line.favorite + ' by ' + line.spread + ' -- this game should be addable now.');
      } else {
        Logger.log('*** No line posted yet on ESPN for this game -- this is exactly why it keeps getting skipped. Nothing to add until oddsmakers post a line. ***');
      }
    } else {
      Logger.log('\nNot found on today\'s live ESPN scoreboard either -- may be a different date, or ESPN uses a different name entirely.');
    }
  } catch (e) {
    Logger.log('\nLive ESPN cross-check failed: ' + e.message);
  }
}

// Dumps the RAW odds data ESPN returns for a specific event, to check whether
// extractEspnLine's parsing is missing something (e.g. an unusual format)
// rather than there genuinely being no odds data at all.
function dumpRawOdds(espnEventId) {
  const todayYmd = formatYYYYMMDD(new Date());
  const events = fetchEspnScoreboardRange(todayYmd, todayYmd);
  const ev = events.find(function(e) { return String(e.id) === String(espnEventId); });
  if (!ev) { Logger.log('Event ' + espnEventId + ' not found on today\'s scoreboard.'); return; }
  const comp = ev.competitions && ev.competitions[0];
  if (!comp) { Logger.log('No competition data on this event.'); return; }
  Logger.log('Event ' + espnEventId + ' raw competition keys: ' + Object.keys(comp).join(', '));
  Logger.log('\nRaw odds field: ' + JSON.stringify(comp.odds));
  if (!comp.odds || comp.odds.length === 0) {
    Logger.log('\n*** comp.odds is empty/missing entirely -- ESPN has genuinely not published any odds provider data for this game yet. ***');
  }
}

// Checks whether specific players' picks for a given week were genuinely
// submitted by them or auto-defaulted to the favorite (via
// applyNoPickDefaults_, which tags every row it creates with
// isAutoDefault=true). Pass an array of team names (as they appear in the
// Players sheet) and the week number.
function checkIfPlayersDefaulted(teamNames, week) {
  const players = sheetToObjects(SHEET_NAMES.PLAYERS);
  const picks = sheetToObjects(SHEET_NAMES.PICKS).filter(function(p) { return Number(p.week) === Number(week); });
  const games = sheetToObjects(SHEET_NAMES.GAMES);

  teamNames.forEach(function(name) {
    const player = players.find(function(p) { return String(p.teamName).toUpperCase() === name.toUpperCase(); });
    if (!player) { Logger.log(name + ': player not found.'); return; }
    const myPicks = picks.filter(function(p) { return p.playerId === player.id; });
    if (myPicks.length === 0) { Logger.log(name + ': no picks on file for week ' + week + ' at all.'); return; }

    const autoCount = myPicks.filter(function(p) { return p.isAutoDefault === true || p.isAutoDefault === 'TRUE'; }).length;
    const manualCount = myPicks.length - autoCount;
    Logger.log(name + ': ' + myPicks.length + ' total pick(s) -- ' + manualCount + ' submitted manually, ' + autoCount + ' auto-defaulted to the favorite.');

    if (autoCount > 0) {
      myPicks.filter(function(p) { return p.isAutoDefault === true || p.isAutoDefault === 'TRUE'; }).forEach(function(p) {
        const g = games.find(function(gg) { return gg.gameId === p.gameId; });
        const label = g ? (g.awayTeam + ' @ ' + g.homeTeam) : p.gameId;
        Logger.log('  AUTO-DEFAULTED: ' + p.pickedTeam + ' (' + label + ')');
      });
    }
    // earliest/latest submittedAt among their manual picks, if any, gives a sense of when they actually engaged
    const manualTimes = myPicks.filter(function(p) { return !(p.isAutoDefault === true || p.isAutoDefault === 'TRUE'); }).map(function(p) { return p.submittedAt; }).filter(Boolean).sort();
    if (manualTimes.length > 0) {
      Logger.log('  Manually submitted between ' + manualTimes[0] + ' and ' + manualTimes[manualTimes.length - 1] + '.');
    }
  });
}

// Cleans up snapshot duplicates caused by the type-mismatch bug in
// apiAdminRefreshSnapshot/autoBackfillMissingLines (now fixed at the source,
// but this repairs damage already done). For any (week, espnEventId) with
// more than one row, keeps only the EARLIEST snapshotAt -- that's the true
// original frozen line, which must never change once set, per the league's
// own "never overwrite Monday's line" rule. Dry run by default.
function cleanupSnapshotDuplicates(week, dryRun) {
  if (dryRun === undefined) dryRun = true;
  const rows = sheetToObjects(SHEET_NAMES.LINE_SNAPSHOT).filter(function(r) { return Number(r.week) === Number(week); });
  const byGame = {};
  rows.forEach(function(r) {
    const key = String(r.espnEventId);
    (byGame[key] = byGame[key] || []).push(r);
  });

  // Identify duplicates to remove by their exact (espnEventId, snapshotAt) pair
  // -- deleteRowsByMatchFast_ rebuilds row objects from raw sheet values and
  // doesn't expose a row number to match against, so content is what we match on.
  const toRemoveKeys = new Set();
  let dupGameCount = 0;
  Object.keys(byGame).forEach(function(key) {
    const group = byGame[key];
    if (group.length <= 1) return;
    dupGameCount++;
    group.sort(function(a, b) { return new Date(a.snapshotAt) - new Date(b.snapshotAt); });
    const keep = group[0];
    const remove = group.slice(1);
    Logger.log(keep.awayTeam + ' @ ' + keep.homeTeam + ' (event ' + key + '): ' + group.length + ' copies found.');
    Logger.log('  KEEPING: favorite=' + keep.favorite + ' spread=' + keep.spread + ' (snapshotAt ' + keep.snapshotAt + ')');
    remove.forEach(function(r) {
      Logger.log('  removing duplicate: favorite=' + r.favorite + ' spread=' + r.spread + ' (snapshotAt ' + r.snapshotAt + ')');
      toRemoveKeys.add(String(r.espnEventId) + '|' + String(r.snapshotAt));
    });
  });

  if (dupGameCount === 0) { Logger.log('No duplicates found for week ' + week + '.'); return; }

  if (dryRun) {
    Logger.log('\nDRY RUN -- ' + dupGameCount + ' game(s) had duplicates, ' + toRemoveKeys.size + ' extra row(s) would be removed. Run cleanupSnapshotDuplicates(' + week + ', false) to actually fix.');
  } else {
    // use the fast batch-rewrite approach given there could be many rows to remove
    deleteRowsByMatchFast_(SHEET_NAMES.LINE_SNAPSHOT, function(row) {
      if (Number(row.week) !== Number(week)) return false;
      return toRemoveKeys.has(String(row.espnEventId) + '|' + String(row.snapshotAt));
    });
    invalidateSheetCache(SHEET_NAMES.LINE_SNAPSHOT);
    Logger.log('\nCleaned up ' + dupGameCount + ' duplicated game(s), removed ' + toRemoveKeys.size + ' extra row(s).');
  }
}

// Automatically backfills any newly-posted lines into the current week's
// snapshot -- this is the same logic as the "Add Missing Lines to Snapshot"
// admin button (apiAdminRefreshSnapshot), just run on a schedule instead of
// requiring someone to remember to click it. Only ADDS games that were
// missing because their line wasn't posted yet at the original Monday
// snapshot; never touches or overwrites an existing frozen line. Set up a
// time-based trigger for this (e.g. daily) from the Apps Script editor:
// Triggers (clock icon) -> Add Trigger -> autoBackfillMissingLines ->
// Time-driven -> Day timer -> whatever time works.
function autoBackfillMissingLines() {
  const week = Number(getSeasonConfig().currentWeek || 1);
  const existing = sheetToObjects(SHEET_NAMES.LINE_SNAPSHOT).filter(function(r) { return Number(r.week) === week; });
  const existingIds = new Set(existing.map(function(r) { return String(r.espnEventId); }));

  // Anchor to this week's OWN games (from kickoffs already on file), not to
  // "today" -- this function runs daily via a scheduled trigger, so computing
  // the window from today's date meant every run after this week's Thursday
  // had passed would reach into next week's Thursday/Friday games and
  // mistakenly tag them with the current week's number.
  const existingKickoffs = existing.map(function(r) { return new Date(r.kickoff); }).filter(function(d) { return !isNaN(d); });
  var rangeStart, rangeEnd;
  if (existingKickoffs.length > 0) {
    rangeStart = new Date(Math.min.apply(null, existingKickoffs) - 24 * 60 * 60 * 1000);
    rangeEnd   = new Date(Math.max.apply(null, existingKickoffs) + 24 * 60 * 60 * 1000);
  } else {
    const now = new Date();
    const dayOfWeek = now.getDay();
    rangeStart = dayOfWeek === 0 ? new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000) : new Date(now.getTime() - ((dayOfWeek + 3) % 7) * 24 * 60 * 60 * 1000);
    rangeEnd = new Date(rangeStart.getTime() + 3 * 24 * 60 * 60 * 1000);
  }
  const events = fetchEspnScoreboardRange(formatYYYYMMDD(rangeStart), formatYYYYMMDD(rangeEnd));

  let added = 0;
  let stillNoLine = 0;
  const snapshotAt = new Date().toISOString();
  const newRows = [];
  events.forEach(function(ev) {
    if (existingIds.has(String(ev.id))) return; // already snapshotted -- never overwrite the frozen line
    const comp = ev.competitions && ev.competitions[0];
    if (!comp) return;
    const competitors = comp.competitors || [];
    const home = competitors.find(function(c) { return c.homeAway === 'home'; });
    const away = competitors.find(function(c) { return c.homeAway === 'away'; });
    if (!home || !away) return;
    const line = extractEspnLine(ev, comp, home, away);
    if (!line.favorite || !line.spread) { stillNoLine++; return; } // still no line posted -- try again next run
    newRows.push({
      week: week, espnEventId: ev.id,
      awayTeam: away.team.displayName, homeTeam: home.team.displayName,
      favorite: line.favorite, spread: line.spread, kickoff: line.kickoff,
      homeLogo: line.homeLogo, awayLogo: line.awayLogo, snapshotAt: snapshotAt
    });
    added++;
  });
  appendObjects_(SHEET_NAMES.LINE_SNAPSHOT, newRows); // one write (was one appendObject per game)
  if (newRows.length) invalidateStateCache(); // snapshotCount is part of the cached state
  // recorded for the nightly diagnostics report
  try {
    PropertiesService.getScriptProperties().setProperty('lastLineBackfill', JSON.stringify({ at: snapshotAt, week: week, added: added, stillNoLine: stillNoLine }));
  } catch (e) {}

  // DISABLED as of week 3: this assumed the snapshot is always more
  // authoritative than the board game's original line, but that's confirmed
  // false -- the picker's early submission can capture the true opening line
  // before the snapshot process runs, and the snapshot can itself land after
  // the line has already moved. Auto-correcting board games from the snapshot
  // risks silently overwriting a CORRECT early line with a WRONG later one.
  // Do not re-enable until this has a real fix (e.g. keep whichever of the
  // two was captured earliest, not whichever is "the snapshot").
  // const corrected = backfillBoardGamesFromSnapshot(week);

  Logger.log('autoBackfillMissingLines: week ' + week + ' -- added ' + added + ' newly-lined game(s), ' + existing.length + ' were already on file.');
}

// Precise, safe fix for the actual bug: applyNoPickDefaults_ used to sweep in
// external games (created for Upset Special "search any game" picks) and add
// a bogus default-to-favorite straight pick for them, since a player's only
// pick on that game is their upset pick and the "already picked?" check
// specifically excludes upset-marked rows. This deletes ONLY rows tagged
// isAutoDefault=true whose game is source='external' -- these should never
// have existed, so they're safe to remove unconditionally, regardless of
// timestamp. Everything else (including a player's real straight pick and
// upset pick on the SAME board game, which is normal and correct) is left
// untouched. Dry run by default; pass dryRun=false to actually delete.
function removeSpuriousExternalDefaults(week, dryRun) {
  if (dryRun === undefined) dryRun = true;
  const games = sheetToObjects(SHEET_NAMES.GAMES).filter(function(g) { return g.source === 'external'; });
  const externalGameIds = new Set(games.map(function(g) { return g.gameId; }));
  const picks = sheetToObjects(SHEET_NAMES.PICKS).filter(function(p) {
    return Number(p.week) === Number(week) && (p.isAutoDefault === true || p.isAutoDefault === 'TRUE') && externalGameIds.has(p.gameId);
  });
  const players = sheetToObjects(SHEET_NAMES.PLAYERS);
  if (picks.length === 0) { Logger.log('No spurious external-game defaults found for week ' + week + '.'); return; }
  picks.forEach(function(p) {
    const player = players.find(function(pl) { return pl.id === p.playerId; });
    const name = player ? (player.teamName || player.name) : p.playerId;
    const g = games.find(function(gg) { return gg.gameId === p.gameId; });
    const label = g ? (g.awayTeam + ' @ ' + g.homeTeam) : p.gameId;
    Logger.log(name + ': bogus default "' + p.pickedTeam + '" for ' + label + ' [row ' + p._row + ']');
  });
  if (dryRun) {
    Logger.log('\nDRY RUN -- ' + picks.length + ' bogus row(s) found, nothing changed. Run removeSpuriousExternalDefaults(' + week + ', false) to delete them.');
  } else {
    // Use the fast batch-rewrite helper, not individual deleteRow() calls --
    // with hundreds of rows to remove, one-at-a-time deletes are slow enough
    // to blow past Apps Script's execution time limit and get cancelled
    // partway through (exactly what happened on the first attempt at this).
    deleteRowsByMatchFast_(SHEET_NAMES.PICKS, function(row) {
      return Number(row.week) === Number(week) && (row.isAutoDefault === true || row.isAutoDefault === 'TRUE') && externalGameIds.has(row.gameId);
    });
    invalidateSheetCache(SHEET_NAMES.PICKS);
    invalidateStateCache();
    Logger.log('\nDeleted ' + picks.length + ' bogus row(s).');
  }
}

// Run manually from the editor with a real, currently-live game's espnEventId
// (find it in the Games sheet's espnEventId column for a game that's kicked
// off) to see exactly what ESPN returns and confirm the fields above are
// mapped correctly.
function debugEspnSummary(espnEventId) {
  var result = apiGetGameSummary({ espnEventId: espnEventId });
  Logger.log(JSON.stringify(result, null, 2));
}

// ---------- FULL STATE ----------

// Computes each player's earliest actual year in the league — checks their own
// CareerHistory rows AND any approved claimed historical team names, since the
// league predates the app itself. joinedSeason alone only reflects when someone
// created their app account (it was set to the app's launch year for everyone
// during the initial data import), not how long they've actually played.
// Returns a map of playerId -> earliest year (or null if no history at all).
function computeMemberSinceMap_() {
  var norm = function(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').trim(); };
  var careerRows = getCareerHistoryCached();
  var players = sheetToObjects(SHEET_NAMES.PLAYERS);
  var claims = [];
  try { claims = sheetToObjects(SHEET_NAMES.NAME_CLAIMS); } catch (e) {}

  // earliest year seen for each normalized team name across all of history
  var earliestByTeam = {};
  careerRows.forEach(function(r) {
    var n = norm(r.teamName);
    var yr = Number(r.year);
    if (!n || !yr) return;
    if (!earliestByTeam[n] || yr < earliestByTeam[n]) earliestByTeam[n] = yr;
  });

  // earliest year already linked directly by playerId in CareerHistory
  var earliestByPlayerId = {};
  careerRows.forEach(function(r) {
    var pid = String(r.playerId || '').trim();
    var yr = Number(r.year);
    if (!pid || !yr) return;
    if (!earliestByPlayerId[pid] || yr < earliestByPlayerId[pid]) earliestByPlayerId[pid] = yr;
  });

  var result = {};
  players.forEach(function(p) {
    var candidates = [];
    if (earliestByPlayerId[p.id]) candidates.push(earliestByPlayerId[p.id]);
    var ownNorm = norm(p.teamName);
    if (earliestByTeam[ownNorm]) candidates.push(earliestByTeam[ownNorm]);
    claims.filter(function(c) { return String(c.playerId) === String(p.id) && c.status === 'approved'; })
      .forEach(function(c) {
        var cn = norm(c.claimedTeamName);
        if (earliestByTeam[cn]) candidates.push(earliestByTeam[cn]);
      });
    result[p.id] = candidates.length ? Math.min.apply(null, candidates) : (Number(p.joinedSeason) || null);
  });
  return result;
}

// ---- State cache ----------------------------------------------------------
// The shared (non-user-specific) half of getState is cached in CacheService.
// Values over 100KB can't be stored in one key, so the JSON is split across
// chunk keys (this used to silently stop caching once the season's games +
// players grew past 90KB, turning EVERY getState into a full multi-sheet read).
//
// Freshness: handle() invalidates the cache after every write action (see
// READ_ONLY_ACTIONS), and a generation counter stops a slow builder (keepWarm or
// a cache-miss request) from re-caching data it read BEFORE a concurrent write.
//
// Manual sheet edits never go through handle(). Without the onSheetChange trigger
// (installSheetChangeTrigger) keepWarm rebuilds every 5 min to pick them up. With it,
// a manual edit busts the cache immediately, so keepWarm only rebuilds when the cache
// is missing or older than STATE_MAX_AGE_WATCHED_MS (a safety net for script-side
// writes run from the editor, which don't fire onChange either).
var STATE_CACHE_KEY = 'appState_v3';
var STATE_CACHE_TTL = 360; // > the 5-min keepWarm interval, so the cache never goes cold between runs
var STATE_CACHE_TTL_WATCHED = 1500; // outlives STATE_MAX_AGE_WATCHED + one keepWarm interval
var STATE_MAX_AGE_WATCHED_MS = 15 * 60 * 1000;
var CACHE_CHUNK = 90000;

// True once installSheetChangeTrigger() has run (runDiagnostics re-syncs this flag
// with the real trigger list every night).
function sheetChangeWatched_() {
  try { return PropertiesService.getScriptProperties().getProperty('sheetChangeTrigger') === '1'; } catch (e) { return false; }
}

function cachePutChunked_(cache, key, str, ttl) {
  var n = Math.ceil(str.length / CACHE_CHUNK);
  if (n > 20) return false; // >1.8MB -- not worth caching
  var entries = {};
  for (var i = 0; i < n; i++) entries[key + '_' + i] = str.substr(i * CACHE_CHUNK, CACHE_CHUNK);
  entries[key + '_n'] = String(n);
  cache.putAll(entries, ttl);
  return true;
}

function cacheGetChunked_(cache, key) {
  var n = Number(cache.get(key + '_n') || 0);
  if (!n) return null;
  var keys = [];
  for (var i = 0; i < n; i++) keys.push(key + '_' + i);
  var got = cache.getAll(keys);
  var parts = [];
  for (var j = 0; j < n; j++) {
    if (got[keys[j]] == null) return null; // a chunk was evicted -- treat as a miss
    parts.push(got[keys[j]]);
  }
  return parts.join('');
}

function stateCacheGen_(cache) { return cache.get('appStateGen') || '0'; }

// Builds the cacheable half of getState from the sheets (used by getState on a
// cache miss AND by keepWarm, which used to keep its own copy of this logic).
function buildSharedState_() {
  // _row (sheet row number) is server-only bookkeeping -- the app never reads it
  var noRow = function(rows) { return rows.map(function(r) { var o = Object.assign({}, r); delete o._row; return o; }); };
  var memberSinceMap = computeMemberSinceMap_();
  var players = sheetToObjects(SHEET_NAMES.PLAYERS).map(function(p) { return {
    id: p.id, name: p.name, teamName: p.teamName, isAdmin: !!p.isAdmin, active: !!p.active,
    joinedSeason: p.joinedSeason, memberSince: memberSinceMap[p.id] || p.joinedSeason, careerPoints: Number(p.careerPoints) || 0, email: p.email || '',
    venmo: p.venmo || '', paypal: p.paypal || '', hasAvatar: !!p.avatar, paymentPref: p.paymentPref || '',
    fcmToken: p.fcmToken || '', scoreNotif: p.scoreNotif || 'each', installedAt: p.installedAt || '',
    isPaid: !!(p.isPaid === true || p.isPaid === 'TRUE'), chatNotif: p.chatNotif || 'on', deactivatedAt: p.deactivatedAt || ''
  }; });
  var seasonObj = getSeasonConfig();
  var season = Object.keys(seasonObj).map(function(k) { return { key: k, value: seasonObj[k] }; });
  var currentWeek = Number(seasonObj.currentWeek || 1);
  return {
    players: players,
    season: season,
    rotation: noRow(sheetToObjects(SHEET_NAMES.ROTATION)),
    games: noRow(sheetToObjects(SHEET_NAMES.GAMES)),
    bowlGames: noRow(sheetToObjects(SHEET_NAMES.BOWL_GAMES)),
    bowlChampion: noRow(sheetToObjects(SHEET_NAMES.BOWL_CHAMPION)),
    bowlLedger: noRow(sheetToObjects(SHEET_NAMES.BOWL_LEDGER)),
    snapshotCount: sheetToObjects(SHEET_NAMES.LINE_SNAPSHOT).filter(function(r) { return Number(r.week) === currentWeek; }).length
  };
}

// Rebuilds the shared state and caches it, unless a write invalidated the cache
// while we were reading (generation changed) -- then the stale build is discarded.
function rebuildStateCache_() {
  var cache = CacheService.getScriptCache();
  var genBefore = stateCacheGen_(cache);
  var shared = buildSharedState_();
  try {
    if (stateCacheGen_(cache) === genBefore) {
      var ttl = sheetChangeWatched_() ? STATE_CACHE_TTL_WATCHED : STATE_CACHE_TTL;
      if (cachePutChunked_(cache, STATE_CACHE_KEY, JSON.stringify(shared), ttl)) {
        cache.put(STATE_CACHE_KEY + '_builtAt', String(Date.now()), ttl);
      }
    }
  } catch(e) { Logger.log('state cache write: ' + e.message); }
  return shared;
}

// True if any current-week game has kicked off and isn't final yet. Pass the
// shared state (from cache) to avoid re-reading the Games/Season sheets.
function hasLiveGamesThisWeek_(shared) {
  var currentWeek, games;
  if (shared) {
    var s = {};
    (shared.season || []).forEach(function(r) { s[r.key] = r.value; });
    currentWeek = Number(s.currentWeek || 1);
    games = shared.games || [];
  } else {
    currentWeek = Number(getSeasonConfig().currentWeek || 1);
    games = sheetToObjects(SHEET_NAMES.GAMES);
  }
  var now = new Date();
  return games.some(function(g) {
    if (Number(g.week) !== currentWeek) return false;
    if (g.isFinal === true || g.isFinal === 'TRUE') return false;
    var kickoff = g.kickoff ? new Date(g.kickoff) : null;
    // stop polling for a game 4 days after kickoff (cancelled/postponed games never
    // go final; the nightly diagnostics report flags them for the admin instead)
    return kickoff && now >= kickoff && now - kickoff < 4 * 86400000;
  });
}

// Live-score refresh + auto-default picks, rate-limited to once per 4 minutes and
// guarded by the script lock. The lock (tryLock(0) = skip if busy, never wait) fixes
// a race where two simultaneous callers both passed the 4-minute check and BOTH
// inserted the same auto-default picks (duplicate picks inflate scores). The
// primary caller is the keepWarm trigger (every 5 min, minAgeMs = 4 min, so every
// run fetches). Players' getState passes USER_SCORE_FETCH_MIN_AGE_MS: with the same
// 4 min, anyone opening the app in the last minute before each keepWarm run paid
// for the whole ESPN fetch + writes + state rebuild -- ~20% of game-time app loads.
// Now they only do it if keepWarm has actually missed a run. Returns true if a fetch ran.
var AUTO_SCORE_FETCH_MIN_AGE_MS = 4 * 60 * 1000;
var USER_SCORE_FETCH_MIN_AGE_MS = 7 * 60 * 1000;
function maybeAutoFetchScores_(shared, minAgeMs) {
  minAgeMs = minAgeMs || AUTO_SCORE_FETCH_MIN_AGE_MS;
  if (!hasLiveGamesThisWeek_(shared)) return false;
  var props = PropertiesService.getScriptProperties();
  if (Date.now() - Number(props.getProperty('lastAutoScoreFetch') || 0) <= minAgeMs) return false;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return false;
  try {
    // re-check inside the lock -- another execution may have just finished a fetch
    if (Date.now() - Number(props.getProperty('lastAutoScoreFetch') || 0) <= minAgeMs) return false;
    props.setProperty('lastAutoScoreFetch', String(Date.now()));
    autoFetchScoresForWeek(Number(getSeasonConfig().currentWeek || 1));
    return true;
  } catch(e) {
    Logger.log('Auto score fetch failed: ' + e.message);
    return false;
  } finally {
    releaseLock_(lock);
  }
}

// The cached shared state, rebuilt from the sheets on a miss. Also used by endpoints
// that only need players/season/games (e.g. the Trophy Room) so they don't re-read
// those sheets. Returns a fresh object each call (safe to add fields to).
function getSharedState_() {
  try {
    var cached = cacheGetChunked_(CacheService.getScriptCache(), STATE_CACHE_KEY);
    if (cached) { perfNote_('stateCache', 'hit'); return JSON.parse(cached); }
  } catch(e) { /* cache miss — fall through to full read */ }
  perfNote_('stateCache', 'miss');
  return rebuildStateCache_();
}

function apiGetState(payload) {
  var shared = getSharedState_();

  // Fallback only -- keepWarm fetches every 5 min. If live games are in progress and
  // keepWarm has missed a run (no fetch in 7+ min), do it now (skipped if busy).
  if (maybeAutoFetchScores_(shared, USER_SCORE_FETCH_MIN_AGE_MS)) {
    invalidateStateCache();
    shared = rebuildStateCache_();
  }

  if (payload && payload.compact) {
    // Current app: picks arrive packed ~10x smaller (see compactPicks_), served from a
    // cache that every write to Picks/Ledger/BowlPicks busts -- so a typical app load
    // does no spreadsheet reads at all. Slow runs are what make Google lose the reply.
    var bundle = getPicksBundle_(currentWeekOf_(shared));
    shared.picksCompact = bundle.picksCompact;
    shared.ledger = bundle.ledger;
    shared.bowlPicks = bundle.bowlPicks;
  } else {
    // Older cached app versions: plain lists read fresh, until they update.
    shared.picks = slimPicksForClient_(sheetToObjects(SHEET_NAMES.PICKS), currentWeekOf_(shared));
    shared.ledger = sheetToObjects(SHEET_NAMES.LEDGER).map(withoutRow_);
    shared.bowlPicks = sheetToObjects(SHEET_NAMES.BOWL_PICKS).map(withoutRow_);
  }
  return Object.assign({ ok: true }, shared);
}

// ---- Picks cache ------------------------------------------------------------
// { week, picksCompact, ledger, bowlPicks } for the current week, cached across
// requests. Busted by invalidatePicksBundle_() on every script write to those tabs
// (via invalidateSheetCache/appendObject), by invalidateStateCache() (router writes,
// manual edits once installSheetChangeTrigger has run), and it expires after 10 min
// as a safety net for raw writes that bypass the helpers. A generation counter stops
// a slow build from caching data it read before a concurrent write.
// When manual edits are watched, the 10-min expiry made keepWarm (every 5 min)
// re-read the whole Picks tab -- the biggest sheet -- on every other run even with
// nothing changed. Then it lives as long as the state cache and keepWarm refreshes
// both on the same 15-min safety-net schedule (STATE_MAX_AGE_WATCHED_MS).
var PICKS_BUNDLE_KEY = 'picksBundle_v1';
var PICKS_BUNDLE_TTL = 600;
var PICKS_BUNDLE_TTL_WATCHED = 1500;

var _picksDirty = false; // this execution wrote to Picks/Ledger/BowlPicks (see releaseLock_ / handle)
function invalidatePicksBundle_() {
  _picksDirty = true;
  try {
    var cache = CacheService.getScriptCache();
    cache.put('picksBundleGen', String(Date.now()) + Math.random().toString(36).slice(2, 6), 21600);
    cache.remove(PICKS_BUNDLE_KEY + '_n');
  } catch (e) {}
  markFrontDoorStale_(); // every state/picks bust passes through here (invalidateStateCache calls it)
}

// ---- Cloudflare front door (worker/, docs/cloudflare-front-door-plan.md) ----
// The Worker answers the busy reads (getState, standings, messages, Trophy Room) from its
// own copies while nothing has changed. Whenever this script busts its own caches, the
// Worker's copies are out of date too, so it is told "stale" (action frontDoorStale + the
// shared secret from Script Properties FRONT_DOOR_URL / FRONT_DOOR_SECRET; nothing is sent
// until both are set). In a web request that's sent ONCE, at the end of handle() after the
// writes are flushed; from triggers / the editor / onSheetChange it's sent right away.
var _inWebRequest = false;
var _frontDoorDirty = false;
function markFrontDoorStale_() {
  if (_inWebRequest) { _frontDoorDirty = true; return; }
  sendFrontDoorStale_();
}

function sendFrontDoorStale_() {
  _frontDoorDirty = false;
  try {
    var props = PropertiesService.getScriptProperties();
    var url = props.getProperty('FRONT_DOOR_URL'), secret = props.getProperty('FRONT_DOOR_SECRET');
    if (!url || !secret) return;
    // A read the Worker sends after this must see the new data: land buffered writes first.
    try { SpreadsheetApp.flush(); } catch (e) {}
    UrlFetchApp.fetch(url, { method: 'post', contentType: 'text/plain', muteHttpExceptions: true,
      payload: JSON.stringify({ action: 'frontDoorStale', secret: secret }) });
  } catch (e) { Logger.log('front door stale signal failed: ' + e.message); }
}

// Run once from the editor after setting FRONT_DOOR_URL / FRONT_DOOR_SECRET: the Worker's
// /health page should then show "lastStaleSignal: 0 min ago".
function testFrontDoorSignal() {
  sendFrontDoorStale_();
  Logger.log('Stale signal sent to ' + (PropertiesService.getScriptProperties().getProperty('FRONT_DOOR_URL') || '(FRONT_DOOR_URL not set)'));
}

function getPicksBundle_(currentWeek) {
  var cache = CacheService.getScriptCache();
  try {
    var raw = cacheGetChunked_(cache, PICKS_BUNDLE_KEY);
    if (raw) {
      var hit = JSON.parse(raw);
      if (hit.week === currentWeek) { perfNote_('picksCache', 'hit'); return hit; }
    }
  } catch (e) {}
  perfNote_('picksCache', 'miss');
  var genBefore = cache.get('picksBundleGen') || '0';
  var bundle = {
    week: currentWeek,
    picksCompact: compactPicks_(slimPicksForClient_(sheetToObjects(SHEET_NAMES.PICKS), currentWeek)),
    ledger: sheetToObjects(SHEET_NAMES.LEDGER).map(withoutRow_),
    bowlPicks: sheetToObjects(SHEET_NAMES.BOWL_PICKS).map(withoutRow_)
  };
  try {
    if ((cache.get('picksBundleGen') || '0') === genBefore) {
      cachePutChunked_(cache, PICKS_BUNDLE_KEY, JSON.stringify(bundle), sheetChangeWatched_() ? PICKS_BUNDLE_TTL_WATCHED : PICKS_BUNDLE_TTL);
    }
  } catch (e) { Logger.log('picks cache write: ' + e.message); }
  return bundle;
}

function withoutRow_(r) { var o = Object.assign({}, r); delete o._row; return o; }

function currentWeekOf_(shared) {
  var wk = 1;
  (shared.season || []).forEach(function(r) { if (r.key === 'currentWeek') wk = Number(r.value || 1); });
  return wk;
}

// Picks are most of the getState payload (every pick of the season, re-downloaded on
// every app open and poll). The app only reads submittedAt for the player's own
// current-week picks (the draft-sync fingerprint in renderPicksBoard), so it is
// dropped for weeks that ended before last week (last week is kept in case the
// admin advanced the week while a game was still open), and _row is never read at
// all. Every other field is kept.
function slimPicksForClient_(picks, currentWeek) {
  return picks.map(function(p) {
    var o = withoutRow_(p);
    if (Number(p.week) < currentWeek - 1) delete o.submittedAt;
    return o;
  });
}

// Packs picks for the wire. Picks were ~85% of getState (440KB of 517KB by week 4,
// +~600 picks a week), and Google's web-app layer started DROPPING replies that big
// ("No action." errors). Each pick becomes a short row of indexes into shared
// lists instead of repeating field names and full team names:
//   { v: 1, p: [playerIds], g: [gameIds], t: [teamNames],
//     r: [[week, pIdx, gIdx, tIdx, flags(1=isUpset, 2=isAutoDefault), submittedAt?], ...] }
// Row order is preserved. The app's unpackPicks() rebuilds identical objects.
function compactPicks_(picks) {
  var lists = { p: [], g: [], t: [] }, index = { p: {}, g: {}, t: {} };
  var idx = function(kind, val) {
    val = val == null ? '' : String(val);
    if (!(val in index[kind])) { index[kind][val] = lists[kind].length; lists[kind].push(val); }
    return index[kind][val];
  };
  var truthy = function(v) { return v === true || v === 'TRUE' || v === 'true'; };
  var rows = picks.map(function(pk) {
    var row = [Number(pk.week), idx('p', pk.playerId), idx('g', pk.gameId), idx('t', pk.pickedTeam),
      (truthy(pk.isUpset) ? 1 : 0) | (truthy(pk.isAutoDefault) ? 2 : 0)];
    if (pk.submittedAt !== undefined && pk.submittedAt !== '') {
      row.push(pk.submittedAt instanceof Date ? pk.submittedAt.toISOString() : pk.submittedAt);
    }
    return row;
  });
  return { v: 1, p: lists.p, g: lists.g, t: lists.t, r: rows };
}

// Bust the state cache whenever players, games, or season config changes.
// Bumping the generation stops any in-flight rebuild from re-caching stale data.
function invalidateStateCache() {
  try {
    var cache = CacheService.getScriptCache();
    cache.put('appStateGen', String(Date.now()) + Math.random().toString(36).slice(2, 6), 21600);
    cache.remove(STATE_CACHE_KEY + '_n');
  } catch(e) {}
  invalidatePicksBundle_(); // same triggers (writes, manual edits, week changes) apply to picks
}

function invalidateTrophyCache(playerId) {
  try { CacheService.getScriptCache().remove('trophy_v4_' + playerId); } catch(e) {}
  markFrontDoorStale_();
}


// fetches current ESPN scores for all non-final games in a given week and updates the sheet.
// only touches finalAwayScore, finalHomeScore, and isFinal -- never touches lines or kickoffs.
function autoFetchScoresForWeek(week) {
  const weekGames = sheetToObjects(SHEET_NAMES.GAMES).filter(g => Number(g.week) === week);
  const allWeekGames = weekGames.filter(g => g.source !== 'external'); // the 10-game board

  // Scores are fetched for EVERY game this week that has kicked off -- including
  // Upset Special games outside the board (source 'external'). Those used to be
  // skipped here, so they sat "pending" until an admin ran Fetch Results.
  const now = new Date();
  const scoreFetchGames = weekGames.filter(g =>
    !(g.isFinal === true || g.isFinal === 'TRUE') &&
    g.espnEventId && !String(g.espnEventId).startsWith('TEST_') &&
    g.kickoff && new Date(g.kickoff) <= now
  );

  if (scoreFetchGames.length > 0) {
    // ESPN scoreboard for the dates these games were played (the bare "current"
    // scoreboard misses Thursday/Friday games once ESPN rolls its default view)
    const events = fetchEspnEventsForGames_(scoreFetchGames);
    const eventMap = {};
    events.forEach(ev => { eventMap[ev.id] = ev; });

    // collected and written in ONE sheet read (was a full Games re-read per game)
    const scoreChanges = [];
    scoreFetchGames.forEach(g => {
      const ev = eventMap[g.espnEventId];
      if (!ev) return;
      const comp = ev.competitions && ev.competitions[0];
      if (!comp) return;
      const competitors = comp.competitors || [];
      const home = competitors.find(c => c.homeAway === 'home');
      const away = competitors.find(c => c.homeAway === 'away');
      if (!home || !away) return;
      const isFinal = comp.status && comp.status.type && comp.status.type.completed;
      const homeScore = home.score || '';
      const awayScore = away.score || '';
      if (homeScore !== '' || awayScore !== '' || isFinal) {
        scoreChanges.push({ match: r => r.gameId === g.gameId, updates: {
          finalHomeScore: homeScore,
          finalAwayScore: awayScore,
          isFinal: !!isFinal
        } });
      }
    });
    updateRowsByMatchBatch_(SHEET_NAMES.GAMES, scoreChanges);
  }

  // auto-apply default picks (favorite) for any game that has kicked off
  // but has players who didn't pick it yet. runs per-game so players who
  // submit late still get credit for games that haven't started yet.
  autoApplyDefaultPicksForWeek(week, allWeekGames);
}

// for each game that has kicked off, fill in missing picks with the favorite
function autoApplyDefaultPicksForWeek(week, games) {
  var now = new Date();
  var players = sheetToObjects(SHEET_NAMES.PLAYERS).filter(function(p) { return p.active; });

  // Read ALL existing picks for this week once up front
  var existingPicks = sheetToObjects(SHEET_NAMES.PICKS).filter(function(p) {
    return Number(p.week) === week;
  });

  // Build a fast lookup: "playerId|gameId" -> true for straight picks already on file
  var pickIndex = {};
  existingPicks.forEach(function(p) {
    if (!(p.isUpset === true || p.isUpset === 'TRUE')) {
      pickIndex[p.playerId + '|' + p.gameId] = true;
    }
  });

  var newDefaults = [];

  games.forEach(function(g) {
    if (!g.kickoff || !g.favorite || g.source === 'external') return;
    var kickoff = new Date(g.kickoff);
    if (now < kickoff) return; // not started yet

    players.forEach(function(player) {
      var key = player.id + '|' + g.gameId;
      if (!pickIndex[key]) {
        // no straight pick yet — add default
        newDefaults.push({
          week: week, playerId: player.id, gameId: g.gameId,
          pickedTeam: g.favorite, isUpset: false,
          isAutoDefault: true, submittedAt: new Date().toISOString()
        });
        // mark as done so we don't double-insert within this run
        pickIndex[key] = true;
      }
    });
  });

  // batch append all new defaults at once (one setValues -- this used to be one
  // appendObject per pick, ~3 spreadsheet calls each, hundreds on a busy Saturday)
  if (newDefaults.length > 0) {
    appendObjects_(SHEET_NAMES.PICKS, newDefaults);
    Logger.log('Auto-defaulted ' + newDefaults.length + ' picks for week ' + week);
  }
}

// ---------- ADMIN: PLAYERS / SEASON ----------

function apiAdminAddPlayer(payload) {
  requireAdmin(payload);
  if (payload.pin) {
    const pinErr = pinProblem_(payload.pin);
    if (pinErr) return { ok: false, error: pinErr };
  }
  const id = genId('p');
  const player = {
    id, name: payload.name, teamName: payload.teamName || payload.name,
    pin: String(payload.pin || '1234'), isAdmin: !!payload.isAdmin, active: true,
    joinedSeason: getSeasonConfig().year, careerPoints: Number(payload.careerPoints) || 0,
    email: payload.email || ''
  };
  appendObject(SHEET_NAMES.PLAYERS, player);
  invalidateStateCache();
  return { ok: true, player };
}

// self-registration: creates a player account with active=false (pending Jeff's approval).
// NOTE (Aug 16 2026): active=false no longer blocks login (see apiLogin) -- it just
// keeps them out of standings/rotation/leaderboards until approved. They can log in
// immediately with the credentials they just chose.
function apiRegisterPlayer(payload) {
  const name = String(payload.name || '').trim();
  const teamName = String(payload.teamName || '').trim();
  const pin = String(payload.pin || '').trim();
  const email = String(payload.email || '').trim();

  if (!name) return { ok: false, error: 'Full name is required.' };
  if (!teamName) return { ok: false, error: 'Team name is required.' };
  const pinErr = pinProblem_(pin);
  if (pinErr) return { ok: false, error: pinErr };
  if (!email || !email.includes('@')) return { ok: false, error: 'A valid email is required.' };

  const players = sheetToObjects(SHEET_NAMES.PLAYERS);

  // prevent duplicate names
  if (players.find(p => String(p.name).trim().toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: 'An account with that name already exists. Contact Jeff if you need help.' };
  }
  // prevent duplicate team names
  if (players.find(p => String(p.teamName).trim().toLowerCase() === teamName.toLowerCase())) {
    return { ok: false, error: 'That team name is already taken. Pick a different one.' };
  }

  const id = genId('p');
  var referredBy = String(payload.referredBy || '').trim();
  appendObject(SHEET_NAMES.PLAYERS, {
    id, name, teamName, pin,
    isAdmin: false,
    active: false, // pending approval — no longer blocks login, see apiLogin
    joinedSeason: getSeasonConfig().year,
    careerPoints: 0,
    email,
    referredBy: referredBy
  });
  // Notify admins by email that a new player registered
  try {
    var admins = sheetToObjects(SHEET_NAMES.PLAYERS).filter(function(p) {
      return (p.isAdmin === true || p.isAdmin === 'TRUE') && p.email;
    });
    admins.forEach(function(admin) {
      MailApp.sendEmail({
        to: admin.email,
        subject: '🏈 New Upset Special Registration: ' + name,
        body: 'New player registration received:\n\nName: ' + name + '\nTeam: ' + teamName + '\nEmail: ' + email + '\n\nLog in to the app → Admin → Pending Players to approve or reject.'
      });
    });
  } catch(e) { Logger.log('Registration email failed: ' + e.message); }
  return { ok: true, message: "You're in! Log in now and take a look around — Jeff will confirm your entry soon." };
}

// returns all pending (active=false, non-admin) players for the admin approval queue
function apiAdminGetPending(payload) {
  requireAdmin(payload);
  const pending = sheetToObjects(SHEET_NAMES.PLAYERS)
    .filter(p => (p.active === false || p.active === 'FALSE') && !p.isAdmin)
    .map(p => ({ id: p.id, name: p.name, teamName: p.teamName, email: p.email, joinedSeason: p.joinedSeason }));
  return { ok: true, pending };
}

// approve a pending player (set active=true) or reject (delete them).
// NOTE (Aug 16 2026): approving now also emails the player (and pushes a
// notification if they already have an FCM token on file). Since pending
// players can already use the app before review, rejecting still hard-deletes
// the row as before -- worth revisiting if that ever needs to change to a
// soft-deactivate instead, now that a rejected player could already have
// picks/messages on file.
function apiAdminApprovePlayer(payload) {
  requireAdmin(payload);
  if (payload.approve) {
    var player = sheetToObjects(SHEET_NAMES.PLAYERS).find(function(p) { return p.id === payload.id; });
    const found = updateRowByMatch(SHEET_NAMES.PLAYERS, r => r.id === payload.id, { active: true });
    if (found && player) {
      try { sendApprovalEmail_(player); } catch(e) { Logger.log('Approval email failed: ' + e.message); }
      try { sendApprovalPush_(player); } catch(e) { Logger.log('Approval push failed: ' + e.message); }
    }
    invalidateStateCache();
    return { ok: found };
  } else {
    // reject: remove the row entirely
    deleteRowsByMatch(SHEET_NAMES.PLAYERS, r => r.id === payload.id);
    invalidateStateCache();
  return { ok: true };
  }
}

// emails the newly-approved player, using the same themed header/footer as every other email
function sendApprovalEmail_(player) {
  if (!player.email || String(player.email).indexOf('@') < 0) return;
  var title = "You're in!";
  var subtitle = 'Your Upset Special account is active.';
  var body =
    '<p style="margin-bottom:16px;">Good news, ' + escapeHtmlGs_(player.name || player.teamName) +
    ' — your registration has been approved and your account is now active.</p>' +
    '<p style="margin-bottom:16px;">Log in with your team name <strong>' + escapeHtmlGs_(player.teamName) +
    '</strong> and the PIN you chose when you signed up.</p>' +
    '<p style="margin:0;"><a href="' + EMAIL_APP_URL + '" style="color:#d4792a;font-weight:700;">Open the app &rarr;</a></p>';
  var html = buildEmailHtml(title, subtitle, body);
  MailApp.sendEmail({
    to: player.email,
    subject: "You're approved — welcome to Upset Special!",
    htmlBody: html,
    name: 'Upset Special League'
  });
}

// pushes an approval notification IF the player already has an FCM token on file.
// Note: a brand-new registrant almost never has one yet, since token registration
// happens after their first login (Profile → enable notifications) — so this mostly
// covers edge cases like a returning player. The email above is the reliable path.
function sendApprovalPush_(player) {
  if (!player.fcmToken || String(player.fcmToken).trim() === '') return;
  var tokens = String(player.fcmToken).split(',').map(function(t) { return t.trim(); }).filter(Boolean);
  if (tokens.length === 0) return;
  tokens.forEach(function (token) {
    sendFcmV1_(
      token,
      "You're approved!",
      'Your Upset Special account is active — log in and make your first pick.',
      { type: 'approval' }
    );
  });
}

function apiAdminUpdatePlayer(payload) {
  requireAdmin(payload);
  const updates = {};
  ['name', 'teamName', 'pin', 'isAdmin', 'active', 'careerPoints', 'deactivatedAt'].forEach(k => {
    if (payload[k] !== undefined) updates[k] = payload[k];
  });
  if (updates.pin !== undefined) {
    const pinErr = pinProblem_(updates.pin);
    if (pinErr) return { ok: false, error: pinErr };
  }
  const found = updateRowByMatch(SHEET_NAMES.PLAYERS, r => r.id === payload.id, updates);
  return { ok: found };
}

function apiAdminSetSeason(payload) {
  requireAdmin(payload);
  Object.keys(payload).forEach(k => {
    if (k === 'action' || k === 'adminId') return;
    setSeasonConfig(k, payload[k]);
  });
  invalidateStateCache();
  return { ok: true };
}

// ---------- ESPN HELPERS (shared by regular season + bowl) ----------

var ESPN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
function espnScoreboardUrl_(dateRangeYYYYMMDD) {
  let url = 'https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?limit=300&groups=80';
  if (dateRangeYYYYMMDD) url += '&dates=' + dateRangeYYYYMMDD;
  return url;
}
function parseEspnEvents_(resp) {
  if (resp.getResponseCode() !== 200) { perfNote_('espnFail', 1); return []; }
  try { return JSON.parse(resp.getContentText()).events || []; } catch (e) { perfNote_('espnFail', 1); return []; }
}

function fetchEspnScoreboard(dateRangeYYYYMMDD) {
  const resp = UrlFetchApp.fetch(espnScoreboardUrl_(dateRangeYYYYMMDD), {
    muteHttpExceptions: true,
    headers: { 'User-Agent': ESPN_UA }
  });
  return parseEspnEvents_(resp);
}

// One-off diagnostic: run this directly from the Apps Script editor. Tests several
// URL variations to pinpoint exactly what's triggering ESPN's 403 block -- the
// groups=80 parameter, the User-Agent header, or something else entirely.
function debugEspnFetch() {
  var ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  var base = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';
  var tests = [
    { label: 'A: plain, no groups, no UA', url: base + '?dates=20260829', headers: {} },
    { label: 'B: limit only, no UA', url: base + '?limit=300&dates=20260829', headers: {} },
    { label: 'C: groups=80, no UA', url: base + '?limit=300&groups=80&dates=20260829', headers: {} },
    { label: 'D: plain, with UA', url: base + '?dates=20260829', headers: { 'User-Agent': ua } },
    { label: 'E: groups=80, with UA', url: base + '?limit=300&groups=80&dates=20260829', headers: { 'User-Agent': ua } },
    { label: 'F: web.api subdomain, groups=80', url: 'https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?limit=300&groups=80&dates=20260829', headers: {} }
  ];
  tests.forEach(function(t) {
    try {
      var resp = UrlFetchApp.fetch(t.url, { muteHttpExceptions: true, headers: t.headers });
      var code = resp.getResponseCode();
      var text = resp.getContentText();
      var eventCount = '?';
      if (code === 200) {
        try { var data = JSON.parse(text); eventCount = data.events ? data.events.length : 'no events key'; }
        catch (e) { eventCount = 'JSON parse failed'; }
      }
      Logger.log(t.label + ' -> status ' + code + ', events: ' + eventCount);
    } catch (e) {
      Logger.log(t.label + ' -> EXCEPTION: ' + e.message);
    }
  });
}

// fetch a range of dates by calling the scoreboard once per day and merging (ESPN's scoreboard endpoint
// only reliably returns ~1 week at a time for a single 'dates' value when a range is passed, so we page by day)
//
// Days are now fetched IN PARALLEL with UrlFetchApp.fetchAll instead of one after
// another (an 11-day window used to be 11 serial ~1-2s requests; a ~35-day bowl
// window could exceed the client timeout on its own). Output is identical: same
// day order, same first-seen dedupe by event id.
function fetchEspnScoreboardRange(startYYYYMMDD, endYYYYMMDD) {
  const start = parseYYYYMMDD(startYYYYMMDD);
  const end = parseYYYYMMDD(endYYYYMMDD);
  const days = [];
  let cur = new Date(start);
  while (cur <= end) {
    days.push(formatYYYYMMDD(cur));
    cur.setDate(cur.getDate() + 1);
  }
  const allEvents = [];
  const seen = {};
  for (let i = 0; i < days.length; i += 20) {
    const reqs = days.slice(i, i + 20).map(ymd => ({ url: espnScoreboardUrl_(ymd), muteHttpExceptions: true, headers: { 'User-Agent': ESPN_UA } }));
    const resps = UrlFetchApp.fetchAll(reqs);
    resps.forEach(resp => {
      parseEspnEvents_(resp).forEach(ev => { if (!seen[ev.id]) { seen[ev.id] = true; allEvents.push(ev); } });
    });
  }
  return allEvents;
}

function parseYYYYMMDD(s) {
  return new Date(Number(s.substring(0, 4)), Number(s.substring(4, 6)) - 1, Number(s.substring(6, 8)));
}
function formatYYYYMMDD(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'America/New_York', 'yyyyMMdd');
}

function matchEspnEvent(events, awayTeam, homeTeam) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const a = norm(awayTeam), h = norm(homeTeam);
  for (const ev of events) {
    const comp = ev.competitions && ev.competitions[0];
    if (!comp) continue;
    const competitors = comp.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home');
    const away = competitors.find(c => c.homeAway === 'away');
    if (!home || !away) continue;
    const homeName = norm(home.team.displayName || home.team.name);
    const awayName = norm(away.team.displayName || away.team.name);
    if ((homeName.includes(h) || h.includes(homeName)) && (awayName.includes(a) || a.includes(awayName))) {
      return extractEspnLine(ev, comp, home, away);
    }
  }
  return null;
}

function extractEspnLine(ev, comp, home, away) {
  let favorite = '', spread = '';
  const odds = comp.odds && comp.odds[0];
  if (odds && odds.details) {
    const detailMatch = String(odds.details).match(/(.*)\s(-?\d+(\.\d+)?)$/);
    if (detailMatch) {
      const teamAbbrev = detailMatch[1].trim();
      spread = Math.abs(parseFloat(detailMatch[2]));
      const homeAbbr = String(home.team.abbreviation || '').toLowerCase().replace(/[^a-z]/g, '');
      const awayAbbr = String(away.team.abbreviation || '').toLowerCase().replace(/[^a-z]/g, '');
      const favNorm = teamAbbrev.toLowerCase().replace(/[^a-z]/g, '');
      if (homeAbbr && favNorm.includes(homeAbbr)) favorite = home.team.displayName;
      else if (awayAbbr && favNorm.includes(awayAbbr)) favorite = away.team.displayName;
      // ESPN's odds text doesn't always use the team's official abbreviation --
      // Air Force is "AFA" on the team but "AF -3.5" in the odds -- so when the rule
      // above finds nothing, try the other way round (abbreviation starts with the
      // odds code), but only if exactly one team matches; then ESPN's per-team
      // favorite flags; if still unclear, leave it blank for the admin to set.
      if (!favorite && favNorm) {
        const homeHit = !!homeAbbr && homeAbbr.startsWith(favNorm);
        const awayHit = !!awayAbbr && awayAbbr.startsWith(favNorm);
        if (homeHit && !awayHit) favorite = home.team.displayName;
        else if (awayHit && !homeHit) favorite = away.team.displayName;
      }
      if (!favorite && odds.homeTeamOdds && odds.homeTeamOdds.favorite === true) favorite = home.team.displayName;
      if (!favorite && odds.awayTeamOdds && odds.awayTeamOdds.favorite === true) favorite = away.team.displayName;
    }
  }
  return {
    eventId: ev.id, favorite, spread,
    rawHome: home.team.displayName, rawAway: away.team.displayName,
    kickoff: ev.date || comp.date || '',
    homeLogo: extractTeamLogo(home.team),
    awayLogo: extractTeamLogo(away.team)
  };
}

// ESPN returns either a `logos` array (preferred, has multiple variants) or a flat `logo` string
// depending on endpoint/sport. Prefer the "default" full-color logo when an array is present.
function extractTeamLogo(team) {
  if (!team) return '';
  var href = '';
  if (Array.isArray(team.logos) && team.logos.length > 0) {
    var def = team.logos.find(function(l) { return Array.isArray(l.rel) && l.rel.includes('default'); }) || team.logos[0];
    href = def.href || '';
  } else {
    href = team.logo || '';
  }
  // force https to avoid mixed-content warnings
  if (href && href.indexOf('http://') === 0) href = href.replace('http://', 'https://');
  return href;
}

// admin can manually re-run the snapshot (e.g. Tuesday when more lines are posted)
// WITHOUT re-posting the board -- existing picks and locked games are untouched.
// Only adds NEW games that weren't in the snapshot; never overwrites existing lines.
function apiAdminRefreshSnapshot(payload) {
  requireAdmin(payload);
  const week = Number(payload.week);
  const existing = sheetToObjects(SHEET_NAMES.LINE_SNAPSHOT).filter(r => Number(r.week) === week);
  const existingIds = new Set(existing.map(r => String(r.espnEventId)));

  // Anchor the search window to THIS WEEK'S OWN games (from kickoffs already on
  // file), not to "today" -- computing it from today's date meant running this
  // on, say, a Saturday could pull a window that reached into NEXT week's
  // Thursday/Friday games, and every one of those got mistakenly tagged with
  // the current week's number since the loop below stamps everything it finds.
  const existingKickoffs = existing.map(r => new Date(r.kickoff)).filter(d => !isNaN(d));
  let rangeStart, rangeEnd;
  if (existingKickoffs.length > 0) {
    rangeStart = new Date(Math.min.apply(null, existingKickoffs) - 24 * 60 * 60 * 1000); // 1 day buffer before earliest known kickoff
    rangeEnd   = new Date(Math.max.apply(null, existingKickoffs) + 24 * 60 * 60 * 1000); // 1 day buffer after latest known kickoff
  } else {
    // fallback only for a week with zero existing snapshot rows at all (the
    // Monday snapshot never ran) -- best-effort guess from today's date
    const now = new Date();
    const dayOfWeek = now.getDay();
    rangeStart = dayOfWeek === 0 ? new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000) : new Date(now.getTime() - ((dayOfWeek + 3) % 7) * 24 * 60 * 60 * 1000);
    rangeEnd = new Date(rangeStart.getTime() + 3 * 24 * 60 * 60 * 1000); // Thu-Sun only, not 10 days
  }
  const events = fetchEspnScoreboardRange(formatYYYYMMDD(rangeStart), formatYYYYMMDD(rangeEnd));

  let added = 0;
  const snapshotAt = new Date().toISOString();
  const newRows = [];

  events.forEach(ev => {
    if (existingIds.has(String(ev.id))) return; // already snapshotted -- never overwrite Monday line
    const comp = ev.competitions && ev.competitions[0];
    if (!comp) return;
    const competitors = comp.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home');
    const away = competitors.find(c => c.homeAway === 'away');
    if (!home || !away) return;
    const line = extractEspnLine(ev, comp, home, away);
    if (!line.favorite || !line.spread) return;
    newRows.push({
      week, espnEventId: ev.id,
      awayTeam: away.team.displayName, homeTeam: home.team.displayName,
      favorite: line.favorite, spread: line.spread, kickoff: line.kickoff,
      homeLogo: line.homeLogo, awayLogo: line.awayLogo, snapshotAt
    });
    added++;
  });
  appendObjects_(SHEET_NAMES.LINE_SNAPSHOT, newRows);

  return { ok: true, added, existing: existing.length };
}

// search across a window of upcoming days for games matching a text query (team name) — used by the
// "any game" Upset Special picker
// pulls every college football game in a date range, regardless of any existing phase --
// used by the admin to seed the 41 first-round bowl matchups from ESPN's schedule
function apiFetchEspnGamesByDateRange(payload) {
  requireAdminCompat_(payload);
  // cap the span: an unbounded range let one request trigger dozens of ESPN fetches
  const spanDays = (parseYYYYMMDD(String(payload.endDate)) - parseYYYYMMDD(String(payload.startDate))) / 86400000;
  if (!(spanDays >= 0) || spanDays > 45) return { ok: false, error: 'Date range must be 0-45 days.' };
  const events = fetchEspnScoreboardRange(payload.startDate, payload.endDate);
  const games = events.map(ev => {
    const comp = ev.competitions && ev.competitions[0];
    if (!comp) return null;
    const competitors = comp.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home');
    const away = competitors.find(c => c.homeAway === 'away');
    if (!home || !away) return null;
    return {
      espnEventId: ev.id, awayTeam: away.team.displayName, homeTeam: home.team.displayName, kickoff: ev.date || comp.date || '',
      homeLogo: extractTeamLogo(home.team), awayLogo: extractTeamLogo(away.team)
    };
  }).filter(Boolean);
  return { ok: true, games };
}

function apiSearchEspnGames(payload) {
  const query = String(payload.query || '').toLowerCase().trim();
  if (query.length < 2) return { ok: true, results: [] };
  // search a 10-day forward window from today by default, or a provided range
  const today = new Date();
  const start = formatYYYYMMDD(today);
  const future = new Date(today.getTime() + 10 * 24 * 60 * 60 * 1000);
  const end = formatYYYYMMDD(future);
  const events = fetchEspnScoreboardRange(start, end);
  const now = new Date();
  const results = [];
  events.forEach(ev => {
    const comp = ev.competitions && ev.competitions[0];
    if (!comp) return;
    const competitors = comp.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home');
    const away = competitors.find(c => c.homeAway === 'away');
    if (!home || !away) return;
    // never surface a game that's already started, finished, or within 5 minutes of kickoff --
    // it can't legally be picked as an Upset Special, so don't even show it as an option
    const isFinal = comp.status && comp.status.type && comp.status.type.completed;
    const kickoff = ev.date || comp.date;
    if (isFinal) return;
    if (kickoff && now >= new Date(new Date(kickoff).getTime() - 5 * 60 * 1000)) return;
    const homeName = String(home.team.displayName || '').toLowerCase();
    const awayName = String(away.team.displayName || '').toLowerCase();
    if (homeName.includes(query) || awayName.includes(query)) {
      const line = extractEspnLine(ev, comp, home, away);
      results.push({
        espnEventId: ev.id, awayTeam: away.team.displayName, homeTeam: home.team.displayName,
        favorite: line.favorite, spread: line.spread, kickoff: line.kickoff,
        homeLogo: line.homeLogo, awayLogo: line.awayLogo
      });
    }
  });
  return { ok: true, results: results.slice(0, 15) };
}

// ---------- REGULAR SEASON: PICKER ROTATION ----------

function apiAdminAssignPicker(payload) {
  requireAdmin(payload);
  const week = Number(payload.week);
  const found = updateRowByMatch(SHEET_NAMES.ROTATION, r => Number(r.week) === week, {
    playerId: payload.playerId, status: 'assigned', assignedAt: new Date().toISOString()
  });
  if (!found) appendObject(SHEET_NAMES.ROTATION, { week, playerId: payload.playerId, status: 'assigned', assignedAt: new Date().toISOString() });
  sendPickerAssignedEmail_(payload.playerId, week);
  return { ok: true };
}

function apiAdminRandomPicker(payload) {
  requireAdmin(payload);
  const week = Number(payload.week);
  const players = sheetToObjects(SHEET_NAMES.PLAYERS).filter(p => p.active && !p.isAdmin);
  const rotation = sheetToObjects(SHEET_NAMES.ROTATION);
  const usedIds = rotation.filter(r => Number(r.week) !== week).map(r => r.playerId);
  let pool = players.filter(p => !usedIds.includes(p.id));
  if (pool.length === 0) pool = players;
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  const found = updateRowByMatch(SHEET_NAMES.ROTATION, r => Number(r.week) === week, {
    playerId: chosen.id, status: 'assigned', assignedAt: new Date().toISOString()
  });
  if (!found) appendObject(SHEET_NAMES.ROTATION, { week, playerId: chosen.id, status: 'assigned', assignedAt: new Date().toISOString() });
  sendPickerAssignedEmail_(chosen.id, week);
  return { ok: true, playerId: chosen.id, playerName: chosen.name };
}

// Notifies a player they've been selected as the week's picker, with Jeff CC'd.
// Failures here are logged but never block the actual assignment -- a missing
// email address or a mail-quota hiccup shouldn't prevent the picker from being
// set, since that's the part that actually matters functionally.
function sendPickerAssignedEmail_(playerId, week) {
  try {
    const player = sheetToObjects(SHEET_NAMES.PLAYERS).find(function(p) { return p.id === playerId; });
    if (!player || !player.email || String(player.email).indexOf('@') < 0) {
      Logger.log('sendPickerAssignedEmail_: no valid email for playerId ' + playerId + ', skipping notification.');
      return;
    }
    const title = "You're the Picker — Week " + week;
    const subtitle = 'Choose 10 Saturday games to build this week\'s board.';
    const body =
      '<p style="margin-bottom:16px;">Hey ' + escapeHtmlGas_(player.teamName || player.name) + ' — you\'ve been selected as the picker for Week ' + week + '.</p>' +
      '<div style="border-left:4px solid #F2B632;background:#fffbf2;border-radius:0 8px 8px 0;padding:14px 16px;margin:18px 0;font-size:14px;color:#3a2a00;line-height:1.6;">' +
      '<strong style="color:#8c6a2a;text-transform:uppercase;font-size:12px;letter-spacing:0.08em;display:block;margin-bottom:6px;">What you need to do</strong>' +
      'Open the app and select <strong>10 Saturday games</strong> to build this week\'s board. Lines and kickoff times come with them automatically -- you\'re just choosing which matchups make the board.' +
      '</div>' +
      '<p style="margin-bottom:16px;">Once you submit your slate, Jeff will review and post it for the league to start making picks.</p>' +
      '<div style="text-align:center;padding:24px 16px;">' +
      '<a href="' + EMAIL_APP_URL + '" style="display:inline-block;background:linear-gradient(135deg,#F2B632 0%,#FF8A3D 55%,#FF4D5E 100%);color:#0d0500;font-family:Arial,sans-serif;font-size:16px;font-weight:900;letter-spacing:0.04em;text-transform:uppercase;text-decoration:none;padding:15px 36px;border-radius:32px;">Open the App &rarr;</a>' +
      '</div>';
    const html = buildEmailHtml(title, subtitle, body);
    MailApp.sendEmail({
      to: player.email,
      cc: JEFF_EMAIL,
      subject: "You're the Picker — Week " + week,
      htmlBody: html,
      name: 'Upset Special League'
    });
    logEmailSend_("You're the Picker — Week " + week, 1, 'picker-assigned-auto', 'system');
  } catch (e) {
    Logger.log('sendPickerAssignedEmail_ failed: ' + e.message);
  }
}

// ---------- REGULAR SEASON: SLATE / LINES / POST ----------

function apiSubmitSlate(payload) {
  const week = Number(payload.week);
  const games = payload.games || [];
  if (games.length < 1 || games.length > 10) return { ok: false, error: 'Slate must have between 1 and 10 games.' };

  // Only this week's assigned picker (or an admin) may submit the slate -- this was
  // completely unauthenticated, so anyone could wipe and replace a week's board.
  const submitter = sheetToObjects(SHEET_NAMES.PLAYERS).find(p => p.id === payload.playerId);
  if (!submitter) return { ok: false, error: 'Please refresh the app and try again.' };
  const isAdmin = submitter.isAdmin === true || submitter.isAdmin === 'TRUE';
  const isPicker = sheetToObjects(SHEET_NAMES.ROTATION).some(r => Number(r.week) === week && r.playerId === submitter.id);
  if (!isAdmin && !isPicker) return { ok: false, error: 'Only this week\'s assigned picker can submit the slate.' };

  // lock: a double-submit used to be able to insert the slate twice
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
  deleteRowsByMatch(SHEET_NAMES.GAMES, g => Number(g.week) === week && g.locked !== true && g.locked !== 'TRUE');

  // load snapshot once so we can look up frozen Sunday lines for each game
  const snapshot = sheetToObjects(SHEET_NAMES.LINE_SNAPSHOT).filter(r => Number(r.week) === week);

  const newGames = [];
  games.forEach(g => {
    // always prefer the snapshot's frozen line over whatever the picker's browser sent --
    // the picker sees live ESPN lines while browsing, but the board must use the opening line
  const snap = g.espnEventId ? snapshot.find(r => String(r.espnEventId) === String(g.espnEventId)) : null;
    const frozenFavorite = snap ? snap.favorite : (g.favorite || '');
    const frozenSpread   = snap ? snap.spread   : (g.spread   || '');
    const frozenKickoff  = snap ? snap.kickoff  : (g.kickoff  || '');
    const source         = snap ? 'snapshot'    : (g.source   || 'espn');

    newGames.push({
      week, gameId: genId('g'),
      espnEventId: g.espnEventId || '',
      awayTeam: g.awayTeam, homeTeam: g.homeTeam,
      favorite: frozenFavorite, spread: frozenSpread,
      source,
      kickoff: frozenKickoff,
      locked: false,
      finalAwayScore: '', finalHomeScore: '', isFinal: false,
      postedAt: '',
      homeLogo: g.homeLogo || snap && snap.homeLogo || '',
      awayLogo: g.awayLogo || snap && snap.awayLogo || ''
    });
  });
  appendObjects_(SHEET_NAMES.GAMES, newGames);
  updateRowByMatch(SHEET_NAMES.ROTATION, r => Number(r.week) === week, { status: 'submitted' });
  invalidateStateCache();
  return { ok: true };
  } finally {
    releaseLock_(lock);
  }
}

// fetch the full college football schedule for a given week so the picker can browse
// and select their 10 games without typing anything. Returns games with lines, kickoffs,
// and logos already attached. Date range defaults to the upcoming Saturday +/- 1 day
// (to catch Friday night and Sunday games too) but the frontend can pass a custom range.
// returns snapshot games for the picker board -- same format as getWeeklyEspnSlate.
// picker sees snapshot lines (opening lines) rather than live ESPN lines.
// if snapshot is empty for this week, returns empty array so caller falls back to ESPN.
function apiGetPickerSlateFromSnapshot(payload) {
  const week = Number(payload.week || getSeasonConfig().currentWeek || 1);
  const snapshot = sheetToObjects(SHEET_NAMES.LINE_SNAPSHOT)
    .filter(r => Number(r.week) === week);
  if (snapshot.length === 0) return { ok: true, games: [] };

  const now = new Date();
  const games = snapshot
    .filter(r => r.awayTeam && r.homeTeam) // skip any blank rows
    .map(r => ({
      espnEventId: r.espnEventId,
      awayTeam: r.awayTeam,
      homeTeam: r.homeTeam,
      favorite: r.favorite,
      spread: r.spread,
      kickoff: r.kickoff,
      homeLogo: r.homeLogo || '',
      awayLogo: r.awayLogo || '',
      source: 'snapshot',
      hasSnapshot: true,
      started: r.kickoff ? now > new Date(r.kickoff) : false,
      statusDetail: ''
    }))
    .sort((a, b) => {
      if (!a.kickoff) return 1;
      if (!b.kickoff) return -1;
      return new Date(a.kickoff) - new Date(b.kickoff);
    });

  return { ok: true, games };
}

function apiGetWeeklyEspnSlate(payload) {
  const now = new Date();
  let startDate, endDate;
  if (payload.startDate && payload.endDate) {
    startDate = payload.startDate;
    endDate = payload.endDate;
  } else {
    // find the upcoming Saturday (or use today if it is Saturday)
    const dayOfWeek = now.getDay(); // 0=Sun, 6=Sat
    const daysUntilSat = dayOfWeek === 6 ? 0 : (6 - dayOfWeek);
    const sat = new Date(now.getTime() + daysUntilSat * 24 * 60 * 60 * 1000);
    // include Friday through Sunday to catch all weekend CFB
    const fri = new Date(sat.getTime() - 1 * 24 * 60 * 60 * 1000);
    const sun = new Date(sat.getTime() + 1 * 24 * 60 * 60 * 1000);
    startDate = formatYYYYMMDD(fri);
    endDate = formatYYYYMMDD(sun);
  }

  const events = fetchEspnScoreboardRange(startDate, endDate);

  // load this week's snapshot so we can show the frozen opening line alongside the current line
  const week = Number(getSeasonConfig().currentWeek || 1);
  const snapshot = sheetToObjects(SHEET_NAMES.LINE_SNAPSHOT).filter(r => Number(r.week) === week);

  const games = [];
  events.forEach(ev => {
    const comp = ev.competitions && ev.competitions[0];
    if (!comp) return;
    const competitors = comp.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home');
    const away = competitors.find(c => c.homeAway === 'away');
    if (!home || !away) return;

    // skip games that have already started or are final
    const isFinal = comp.status && comp.status.type && comp.status.type.completed;
    if (isFinal) return;
    const kickoff = ev.date || comp.date || '';
    const started = kickoff && new Date() > new Date(kickoff);

    const line = extractEspnLine(ev, comp, home, away);
    // String() both sides: Sheets returns numeric ids while ESPN's are strings, so the
    // strict compare never matched and the frozen snapshot line was never shown
    const snap = snapshot.find(r => String(r.espnEventId) === String(ev.id));
    const statusType = comp.status && comp.status.type;

    // never expose the current live ESPN line for games that have a snapshot --
    // only the frozen opening line is shown. For games without a snapshot yet,
    // show the live line clearly labeled as not yet frozen.
    games.push({
      espnEventId: ev.id,
      awayTeam: away.team.displayName,
      homeTeam: home.team.displayName,
      awayAbbr: away.team.abbreviation || '',
      homeAbbr: home.team.abbreviation || '',
      favorite: snap ? snap.favorite : line.favorite,
      spread:   snap ? snap.spread   : line.spread,
      kickoff:  snap ? snap.kickoff  : line.kickoff,
      source: snap ? 'snapshot' : 'espn',
      homeLogo: line.homeLogo,
      awayLogo: line.awayLogo,
      started: !!started,
      statusDetail: statusType && statusType.shortDetail || '',
      hasSnapshot: !!snap   // tells the frontend whether this is a frozen line or a live one
    });
  });

  // sort by kickoff time
  games.sort((a, b) => {
    if (!a.kickoff) return 1;
    if (!b.kickoff) return -1;
    return new Date(a.kickoff) - new Date(b.kickoff);
  });

  return { ok: true, games, startDate, endDate };
}

function apiAdminFetchEspnLines(payload) {
  requireAdmin(payload);
  const week = Number(payload.week);
  const games = sheetToObjects(SHEET_NAMES.GAMES).filter(g => Number(g.week) === week);
  const events = fetchEspnScoreboard();
  const updated = [];
  const changes = [];
  games.forEach(g => {
    const match = matchEspnEvent(events, g.awayTeam, g.homeTeam);
    if (match) {
      changes.push({ match: r => r.gameId === g.gameId, updates: {
        espnEventId: match.eventId, favorite: match.favorite, spread: match.spread,
        source: 'espn', kickoff: match.kickoff, homeLogo: match.homeLogo, awayLogo: match.awayLogo
      } });
      updated.push({ gameId: g.gameId, favorite: match.favorite, spread: match.spread, matched: true });
    } else {
      updated.push({ gameId: g.gameId, matched: false });
    }
  });
  updateRowsByMatchBatch_(SHEET_NAMES.GAMES, changes);
  invalidateStateCache();
  return { ok: true, updated };
}

function apiAdminOverrideLine(payload) {
  requireAdmin(payload);
  const updates = { favorite: payload.favorite, spread: payload.spread, source: 'manual' };
  if (payload.kickoff) updates.kickoff = payload.kickoff;
  const found = updateRowByMatch(SHEET_NAMES.GAMES, r => r.gameId === payload.gameId, updates);
  return { ok: found };
}

// Board games whose favorite or spread differs from ESPN's frozen opening line for
// the same event. Games without a frozen line (or where ESPN had no clear favorite)
// are skipped -- there's nothing reliable to compare against.
function boardLineMismatches_(week, games) {
  const snap = {};
  sheetToObjects(SHEET_NAMES.LINE_SNAPSHOT)
    .filter(r => Number(r.week) === week)
    .forEach(r => { if (!snap[String(r.espnEventId)]) snap[String(r.espnEventId)] = r; });
  const out = [];
  games.filter(g => g.source !== 'external' && g.espnEventId).forEach(g => {
    const s = snap[String(g.espnEventId)];
    if (!s || !String(s.favorite || '').trim()) return;
    const favDiff = String(g.favorite).trim() !== String(s.favorite).trim();
    const spreadDiff = Math.abs((Number(g.spread) || 0) - (Number(s.spread) || 0)) >= 0.5;
    if (!favDiff && !spreadDiff) return;
    out.push({
      game: g.awayTeam + ' @ ' + g.homeTeam,
      kind: favDiff ? 'favorite' : 'spread',
      board: g.favorite + ' by ' + g.spread,
      espn: s.favorite + ' by ' + s.spread
    });
  });
  return out;
}

function apiAdminPostWeek(payload) {
  // notification called after board is posted (below)
  requireAdmin(payload);
  const week = Number(payload.week);
  const games = sheetToObjects(SHEET_NAMES.GAMES).filter(g => Number(g.week) === week);
  // Name EVERY incomplete game and what it lacks -- the old message stopped at the
  // first one without saying which, so admins fixed the board by trial and error.
  const incomplete = games.map(g => ({
    gameId: g.gameId, game: g.awayTeam + ' @ ' + g.homeTeam,
    missing: [g.favorite === '' ? 'favorite' : '', g.spread === '' ? 'spread' : '', g.kickoff === '' ? 'kickoff' : ''].filter(Boolean)
  })).filter(x => x.missing.length);
  if (incomplete.length) return {
    ok: false, incomplete: incomplete,
    error: 'Every game needs a favorite, spread, and kickoff time before posting. Fix: ' +
      incomplete.map(x => x.game + ' (no ' + x.missing.join(', no ') + ')').join('; ')
  };

  // Automatically snapshot every college football game ESPN has for this week --
  // this freezes the opening lines so upset special picks always use the opening line
  // regardless of when the player makes their pick later in the week. Done BEFORE
  // locking so the board can be checked against it (it only ever adds missing games,
  // so running it here even if the admin then cancels changes no frozen line).
  snapshotWeeklyLines(week);
  invalidateSheetCache(SHEET_NAMES.LINE_SNAPSHOT);

  // Board vs ESPN's frozen opening lines: a flipped favorite (Week 5 2026 went up with
  // Navy favored when ESPN had Air Force -3.5) or a different spread must be confirmed.
  // Only apps that can show the warning ask for it (checkLines) -- older cached apps
  // post exactly as before.
  if (payload.checkLines && !payload.confirmLineMismatches) {
    const mismatches = boardLineMismatches_(week, games);
    if (mismatches.length) return { ok: true, posted: false, needsConfirm: true, mismatches: mismatches };
  }

  const postedAt = new Date().toISOString();
  updateRowsByMatchBatch_(SHEET_NAMES.GAMES, games.map(g => ({ match: r => r.gameId === g.gameId, updates: { locked: true, postedAt: postedAt } })));
  updateRowByMatch(SHEET_NAMES.ROTATION, r => Number(r.week) === week, { status: 'posted' });

  invalidateStateCache();
  // Send push notification to all players that the board is posted
  try { sendPickReminder(week); } catch(e) { Logger.log('Pick reminder push failed: ' + e.message); }
  // Automatically schedule this week's two deadline reminders (3 hours and 90
  // minutes before the first game), based on this week's actual kickoff times.
  // Runs hands-free every time a board is posted — no manual step needed.
  try { scheduleWeeklyPickReminders(week); } catch(e) { Logger.log('Reminder scheduling failed: ' + e.message); }
  return { ok: true };
}

// =================================================================
// SCHEDULED MONDAY SNAPSHOT
// =================================================================

// This function runs automatically every Monday morning via a time-based trigger.
// It snapshots every CFB game ESPN has for the week so lines are ready before the
// picker even logs in. Run installWeeklyTrigger() ONCE from the Apps Script editor
// to set it up -- after that it runs itself every week without any manual action.
function weeklyMondaySnapshot() {
  ensureSheets();
  const week = Number(getSeasonConfig().currentWeek || 1);
  const count = snapshotWeeklyLines(week);
  invalidateStateCache(); // trigger run, not via handle() -- snapshotCount is cached
  // DISABLED as of week 3 -- see the matching note in autoBackfillMissingLines.
  // Auto-correcting board games from the snapshot risks silently overwriting a
  // correct, early-captured board line with a wrong, later-captured snapshot
  // value. Do not re-enable until the logic correctly keeps whichever of the
  // two was captured earliest, rather than always trusting the snapshot.
  // const corrected = backfillBoardGamesFromSnapshot(week);
  Logger.log('Monday auto-snapshot complete. Week ' + week + ', ' + count + ' games stored.');
}

// If the picker submitted their 10-game slate before this week's official
// Monday snapshot existed (e.g. Jeff sends the picker invite for next week
// while it's still this week), apiSubmitSlate had nothing to freeze the line
// from yet and fell back to whatever live ESPN line was showing at that exact
// moment -- which is NOT the same as the intended Monday opening line, and
// nothing previously went back to fix it once the real snapshot became
// available. This corrects any such board game (source !== 'snapshot') to the
// now-available official line, but only if it hasn't started/locked yet --
// never touches a game once picks could already be locked in against it.
function backfillBoardGamesFromSnapshot(week) {
  const snapshot = sheetToObjects(SHEET_NAMES.LINE_SNAPSHOT).filter(function(r) { return Number(r.week) === week; });
  if (snapshot.length === 0) return 0;
  const boardGames = sheetToObjects(SHEET_NAMES.GAMES).filter(function(g) {
    return Number(g.week) === week && g.source !== 'external' && g.source !== 'snapshot';
  });
  let corrected = 0;
  boardGames.forEach(function(g) {
    if (!g.espnEventId) return;
    // Note: g.locked means "posted to the board", NOT "kickoff has passed" --
    // it's set true immediately when the week is posted, so checking it here
    // would block correction for every board game right away. The kickoff-time
    // check below is what actually determines whether it's safe to correct.
    const now = new Date();
    if (g.kickoff && now > new Date(g.kickoff)) return; // already started -- too late to correct
    const snap = snapshot.find(function(r) { return String(r.espnEventId) === String(g.espnEventId); });
    if (!snap) return;
    updateRowByMatch(SHEET_NAMES.GAMES, function(row) { return row.gameId === g.gameId; }, {
      favorite: snap.favorite, spread: snap.spread, kickoff: snap.kickoff, source: 'snapshot'
    });
    corrected++;
  });
  if (corrected > 0) invalidateSheetCache(SHEET_NAMES.GAMES);
  return corrected;
}

// Checks ESPN's CURRENT live scoreboard for a date range and reports how many
// games have a posted betting line vs how many don't yet. Doesn't touch the
// snapshot or any stored data -- purely a live, point-in-time check.
function checkLinesPostedForDateRange(startYYYYMMDD, endYYYYMMDD) {
  const events = fetchEspnScoreboardRange(startYYYYMMDD, endYYYYMMDD);
  let withLine = 0, withoutLine = 0;
  const missing = [];
  events.forEach(function(ev) {
    const comp = ev.competitions && ev.competitions[0];
    if (!comp) return;
    const competitors = comp.competitors || [];
    const home = competitors.find(function(c) { return c.homeAway === 'home'; });
    const away = competitors.find(function(c) { return c.homeAway === 'away'; });
    if (!home || !away) return;
    const line = extractEspnLine(ev, comp, home, away);
    if (line.favorite && line.spread !== '') {
      withLine++;
    } else {
      withoutLine++;
      missing.push(away.team.displayName + ' @ ' + home.team.displayName + ' (kickoff ' + (ev.date || '') + ')');
    }
  });
  Logger.log(events.length + ' total game(s) found for ' + startYYYYMMDD + '-' + endYYYYMMDD + '.');
  Logger.log(withLine + ' have a posted line, ' + withoutLine + ' do not yet.');
  if (missing.length > 0) {
    Logger.log('\nGames still missing a line:');
    missing.forEach(function(m) { Logger.log('  ' + m); });
  }
}

// Run this ONCE from the Apps Script editor (select it from the function dropdown
// and click Run) to install the weekly trigger. You never need to run it again --
// it sets up a permanent schedule that survives deploys and script edits.
// Fires every Sunday between 8-9 PM in your Apps Script project timezone
// (check Project Settings > Time zone if needed -- should be America/New_York).
function installWeeklyTrigger() {
  // remove any existing weekly snapshot triggers first to avoid duplicates
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'weeklyMondaySnapshot') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('weeklyMondaySnapshot')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(20)
    .create();
  Logger.log('Trigger installed! The app will now automatically snapshot all CFB opening lines from ESPN every Sunday between 8-9 PM. No further action needed -- it runs itself every week. Verify it under Apps Script -> Triggers (clock icon in the left sidebar).');
}

// Run this ONCE to install the trigger that picks up newly-posted lines
// throughout the week for games that had none yet at the Sunday snapshot
// (never overwrites an already-frozen line -- only adds what was missing).
// Every 6 hours (was once a day) so games get a line -- and become pickable as
// an Upset Special -- soon after ESPN posts one.
function installAutoBackfillTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'autoBackfillMissingLines') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('autoBackfillMissingLines')
    .timeBased()
    .everyHours(6)
    .create();
  Logger.log('Trigger installed! The app will now check ESPN for newly-posted lines every 6 hours and add them to that week\'s snapshot -- never touching an already-frozen line. Verify it under Apps Script -> Triggers (clock icon in the left sidebar).');
}

// Lists every trigger currently installed on this project, so you can check
// what's actually running without digging through the Triggers UI.
function listInstalledTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  if (triggers.length === 0) { Logger.log('No triggers installed at all.'); return; }
  triggers.forEach(function(t) {
    Logger.log(t.getHandlerFunction() + ' -- ' + t.getEventType() + (t.getTriggerSource() ? ' (' + t.getTriggerSource() + ')' : ''));
  });
}

// Investigates the reported UNC @ Clemson line discrepancy (contest showing
// 8.5, app's official snapshot showing 3.5) -- checks for duplicate snapshot
// rows for this game, then cross-references today's live ESPN line.
function checkClemsonLineDiscrepancy() {
  cleanupSnapshotDuplicates(3, true); // dry run, week 3 -- catches a duplicate-row scenario
  Logger.log('\n--- Cross-checking Clemson vs live ESPN ---\n');
  diagnoseSnapshotTeam(3, 'Clemson');
}

// Board games hold the true early-week opening lines Jeff locked in at
// submission time; the snapshot process, even running "early" in the week,
// can still land after a line has already moved from its true opening value
// (confirmed directly by Tony, who tracked these lines all week -- this is
// NOT something a same-week web search can verify after the fact). This
// checks every week-3 board game against the snapshot and, wherever they
// differ, brings the SNAPSHOT up to match the BOARD's value. Dry run by default.
function syncWeek3SnapshotToBoard(dryRun) {
  if (dryRun === undefined) dryRun = true;
  const boardGames = sheetToObjects(SHEET_NAMES.GAMES).filter(function(g) {
    return Number(g.week) === 3 && g.source !== 'external';
  });
  const snapshot = sheetToObjects(SHEET_NAMES.LINE_SNAPSHOT).filter(function(r) { return Number(r.week) === 3; });

  let mismatches = 0;
  boardGames.forEach(function(g) {
    if (!g.espnEventId) return;
    const snap = snapshot.find(function(r) { return String(r.espnEventId) === String(g.espnEventId); });
    if (!snap) { Logger.log(g.awayTeam + ' @ ' + g.homeTeam + ': no snapshot row at all -- separate issue, not fixed by this.'); return; }
    if (String(snap.favorite) === String(g.favorite) && Number(snap.spread) === Number(g.spread)) return; // already matches

    mismatches++;
    Logger.log(g.awayTeam + ' @ ' + g.homeTeam + ': BOARD has ' + g.favorite + ' by ' + g.spread + ', SNAPSHOT has ' + snap.favorite + ' by ' + snap.spread + '.');
    if (!dryRun) {
      updateRowByMatch(SHEET_NAMES.LINE_SNAPSHOT, function(row) {
        return Number(row.week) === 3 && String(row.espnEventId) === String(g.espnEventId);
      }, { favorite: g.favorite, spread: g.spread, kickoff: g.kickoff });
      Logger.log('  -> snapshot corrected to match the board.');
    }
  });

  if (mismatches === 0) { Logger.log('No mismatches found between week 3 board games and the snapshot.'); return; }
  if (dryRun) {
    Logger.log('\nDRY RUN -- ' + mismatches + ' mismatch(es) found, nothing changed. Run syncWeek3SnapshotToBoard(false) to fix.');
  } else {
    invalidateSheetCache(SHEET_NAMES.LINE_SNAPSHOT);
    Logger.log('\nFixed ' + mismatches + ' mismatch(es) -- snapshot now matches the board for week 3.');
  }
}

function checkWeek3BoardVsSnapshot() {
  syncWeek3SnapshotToBoard(true); // dry run -- lists every mismatch, both sides shown
}

function applyWeek3SnapshotFix() {
  syncWeek3SnapshotToBoard(false); // actually applies the fix
}

// Run this from the Apps Script editor any time you want to manually trigger the
// snapshot outside of schedule -- e.g. right now to test it, or mid-week if you
// want to pick up games ESPN added after Monday.
// Remember: this only ADDS new games, never overwrites already-snapshotted lines.
// Run snapshot for a specific date range -- useful when the week is not the current week
// e.g. runSnapshotForDate('20260829') to capture Week 0 games on Aug 29
function runSnapshotForDate(startYYYYMMDD, endYYYYMMDD) {
  ensureSheets();
  const week = Number(getSeasonConfig().currentWeek || 0);
  const existing = sheetToObjects(SHEET_NAMES.LINE_SNAPSHOT).filter(r => Number(r.week) === week);
  const existingIds = new Set(existing.map(r => r.espnEventId));

  const start = startYYYYMMDD || '20260827';
  const end   = endYYYYMMDD   || '20260829';

  Logger.log('Fetching ESPN games from ' + start + ' to ' + end + ' for week ' + week);
  const events = fetchEspnScoreboardRange(start, end);
  Logger.log('ESPN returned ' + events.length + ' events');

  let added = 0;
  const now = new Date();
  const snapshotAt = now.toISOString();

  events.forEach(ev => {
    if (existingIds.has(ev.id)) return;
    const comp = ev.competitions && ev.competitions[0];
    if (!comp) return;
    const competitors = comp.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home');
    const away = competitors.find(c => c.homeAway === 'away');
    if (!home || !away) return;
    const line = extractEspnLine(ev, comp, home, away);
    if (!line.favorite || !line.spread) {
      Logger.log('Skipping ' + (away.team && away.team.displayName) + ' @ ' + (home.team && home.team.displayName) + ' — no line yet');
      return;
    }
    const kickoff = comp.startDate || '';
    appendObject(SHEET_NAMES.LINE_SNAPSHOT, {
      week:        week,
      espnEventId: ev.id,
      awayTeam:    away.team && away.team.displayName || '',
      homeTeam:    home.team && home.team.displayName || '',
      favorite:    line.favorite,
      spread:      line.spread,
      kickoff:     kickoff,
      snapshotAt:  snapshotAt,
      source:      'manual'
    });
    existingIds.add(ev.id);
    added++;
  });

  Logger.log('runSnapshotForDate complete — ' + added + ' games added for week ' + week);
  return { added: added, week: week };
}

function runSnapshotNow() {
  ensureSheets();
  const week = Number(getSeasonConfig().currentWeek || 1);
  const existing = sheetToObjects(SHEET_NAMES.LINE_SNAPSHOT).filter(r => Number(r.week) === week);
  const existingIds = new Set(existing.map(r => r.espnEventId));

  // for the manual run, only add NEW games (same logic as apiAdminRefreshSnapshot)
  // so we never overwrite a Monday line that was already captured
  const now = new Date();
  const dayOfWeek = now.getDay();
  const thursday = dayOfWeek === 0
    ? new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000)
    : new Date(now.getTime() - ((dayOfWeek + 3) % 7) * 24 * 60 * 60 * 1000);
  const followingSunday = new Date(thursday.getTime() + 10 * 24 * 60 * 60 * 1000);
  const events = fetchEspnScoreboardRange(formatYYYYMMDD(thursday), formatYYYYMMDD(followingSunday));
  let added = 0;
  const snapshotAt = now.toISOString();
  events.forEach(ev => {
    if (existingIds.has(ev.id)) return;
    const comp = ev.competitions && ev.competitions[0];
    if (!comp) return;
    const competitors = comp.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home');
    const away = competitors.find(c => c.homeAway === 'away');
    if (!home || !away) return;
    const line = extractEspnLine(ev, comp, home, away);
    if (!line.favorite || !line.spread) return;
    appendObject(SHEET_NAMES.LINE_SNAPSHOT, {
      week, espnEventId: ev.id,
      awayTeam: away.team.displayName, homeTeam: home.team.displayName,
      favorite: line.favorite, spread: line.spread, kickoff: line.kickoff,
      homeLogo: line.homeLogo, awayLogo: line.awayLogo, snapshotAt
    });
    added++;
  });
  Logger.log('Done! Week ' + week + ': ' + added + ' new games added (' + existing.length + ' already on file). Total: ' + (existing.length + added) + ' games in the snapshot.');
}

// pulls every CFB game ESPN has for the current/upcoming week and writes them to LineSnapshot
// with this snapshot's lines frozen. Safe to run Sunday evening -- window looks forward.
function snapshotWeeklyLines(week) {
  try {
    const now = new Date();
    const DAY_MS = 24 * 60 * 60 * 1000;

    // Window: today through the coming Sunday (Mon-Sun covers Tue/Wed MACtion,
    // Thu/Fri/Sat, and Sunday leftovers; run on a Sunday it covers the week ahead).
    // Extended to the day after the board's last kickoff if the board runs later.
    // The OLD window ran from the most recent Thursday for 10 days -- it pulled in
    // last week's already-played games AND next week's Thu-Sat games, tagging all
    // of them with this week's number.
    const daysToSunday = (7 - now.getDay()) % 7 || 7;
    let windowEnd = new Date(now.getTime() + daysToSunday * DAY_MS);
    const boardKickoffs = sheetToObjects(SHEET_NAMES.GAMES)
      .filter(g => Number(g.week) === week && g.source !== 'external' && g.kickoff)
      .map(g => new Date(g.kickoff).getTime()).filter(t => !isNaN(t));
    if (boardKickoffs.length) {
      const lastBoard = new Date(Math.max.apply(null, boardKickoffs) + DAY_MS);
      if (lastBoard > windowEnd) windowEnd = lastBoard;
    }
    const events = fetchEspnScoreboardRange(formatYYYYMMDD(now), formatYYYYMMDD(windowEnd));

    // FROZEN LINES ARE NEVER OVERWRITTEN. This used to delete and rebuild the whole
    // week's snapshot every time it ran (Monday trigger, and again on every Post
    // Week), replacing opening lines with whatever ESPN showed at that moment.
    // Now it only ADDS games that aren't in this week's snapshot yet.
    const existingIds = {};
    sheetToObjects(SHEET_NAMES.LINE_SNAPSHOT)
      .filter(r => Number(r.week) === week)
      .forEach(r => { existingIds[String(r.espnEventId)] = true; });

    const snapshotAt = now.toISOString();
    let count = 0;
    const snapRows = [];

    events.forEach(ev => {
      if (existingIds[String(ev.id)]) return; // already frozen -- keep the original line
      const comp = ev.competitions && ev.competitions[0];
      if (!comp) return;
      const competitors = comp.competitors || [];
      const home = competitors.find(c => c.homeAway === 'home');
      const away = competitors.find(c => c.homeAway === 'away');
      if (!home || !away) return;

      const line = extractEspnLine(ev, comp, home, away);

      // only snapshot games that actually have a line -- no point storing lineless games
      // since they can't be used as upset specials anyway (no line = no point value)
      if (!line.favorite || !line.spread) return;

      snapRows.push({
        week,
        espnEventId: ev.id,
        awayTeam: away.team.displayName,
        homeTeam: home.team.displayName,
        favorite: line.favorite,
        spread: line.spread,
        kickoff: line.kickoff,
        homeLogo: line.homeLogo,
        awayLogo: line.awayLogo,
        snapshotAt
      });
      count++;
    });
    // one setValues for the whole snapshot (was one appendObject per game -- 100-300
    // games x ~3 spreadsheet calls each, the biggest single cause of Post Week timeouts)
    appendObjects_(SHEET_NAMES.LINE_SNAPSHOT, snapRows);

    return count;
  } catch(e) {
    // snapshot failure is non-fatal -- log it but don't block the post action
    Logger.log('Line snapshot failed: ' + e.message);
    return 0;
  }
}

// search the Monday snapshot for games matching a query -- used by the upset special picker.
// Returns only games whose line was captured at post time, never live ESPN data.
function apiSearchSnapshotGames(payload) {
  const week = Number(payload.week || 0);
  const query = String(payload.query || '').toLowerCase().trim();
  const listAll = !!payload.listAll;
  if (!listAll && query.length < 2) return { ok: true, results: [] };

  const now = new Date();
  const snapshot = sheetToObjects(SHEET_NAMES.LINE_SNAPSHOT)
    .filter(r => Number(r.week) === week);

  if (snapshot.length === 0) {
    return { ok: false, error: 'No line snapshot found for this week. Ask the commissioner to re-post the board to generate the snapshot.', results: [] };
  }

  const notStarted = r => {
    if (!r.kickoff) return true;
    const lockTime = new Date(new Date(r.kickoff).getTime() - 5 * 60 * 1000);
    return now < lockTime;
  };

  const filtered = listAll
    ? snapshot.filter(notStarted)
    : snapshot.filter(r => {
        const matchesQuery = String(r.awayTeam || '').toLowerCase().includes(query) ||
                             String(r.homeTeam || '').toLowerCase().includes(query);
        return matchesQuery && notStarted(r);
      });

  const sorted = filtered.sort((a, b) => new Date(a.kickoff || 0) - new Date(b.kickoff || 0)).slice(0, listAll ? 200 : 20);

  // Fetch the live scoreboard once for the actual date span covered by this
  // batch, so every result can show today's current line next to the frozen
  // Monday line -- lets players spot real line movement without a per-game
  // lookup. If this fails for any reason, results still return with just the
  // Monday line, same as before -- current-line data is a bonus, not required.
  let liveEvents = [];
  try {
    const kickoffs = sorted.map(r => r.kickoff).filter(Boolean).map(k => new Date(k));
    if (kickoffs.length > 0) {
      const minD = new Date(Math.min.apply(null, kickoffs));
      const maxD = new Date(Math.max.apply(null, kickoffs));
      liveEvents = fetchEspnScoreboardRange(formatYYYYMMDD(minD), formatYYYYMMDD(maxD));
    }
  } catch (e) {
    Logger.log('apiSearchSnapshotGames: live odds fetch failed, continuing with snapshot line only: ' + e.message);
  }

  const results = sorted.map(r => {
    const out = {
      espnEventId: r.espnEventId,
      awayTeam: r.awayTeam,
      homeTeam: r.homeTeam,
      favorite: r.favorite,
      spread: r.spread,
      kickoff: r.kickoff,
      homeLogo: r.homeLogo,
      awayLogo: r.awayLogo,
      isSnapshotLine: true  // flag so frontend can show "Monday line" label
    };
    if (liveEvents.length > 0) {
      const live = matchEspnEvent(liveEvents, r.awayTeam, r.homeTeam);
      if (live && live.favorite && live.spread !== '') {
        out.currentFavorite = live.favorite;
        out.currentSpread = live.spread;
      }
    }
    return out;
  });

  return { ok: true, results };
}

// wipes all data for a given week -- games, picks, snapshot rows, and rotation entry.
// use this to clear Week 0 test data before starting the real season.
// does NOT touch the Ledger or any other weeks.
function apiAdminFixCareerMapping(payload) {
  requireAdmin(payload);
  var teamName = payload.teamName;
  var playerId = payload.playerId;
  if (!teamName || !playerId) return { ok: false, error: 'teamName and playerId required.' };

  // look up the player
  var players = sheetToObjects(SHEET_NAMES.PLAYERS);
  var player = players.find(function(p) { return p.id === playerId; });
  if (!player) return { ok: false, error: 'Player not found: ' + playerId };

  // normalize for matching
  function norm(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('CareerHistory');
  if (!sheet) return { ok: false, error: 'CareerHistory sheet not found.' };

  var data = sheet.getDataRange().getValues();
  var changes = [];
  for (var r = 1; r < data.length; r++) {
    if (norm(data[r][2]) === norm(teamName) && data[r][5] === 'NO') {
      changes.push({ row: r + 1, values: [player.id, player.name, player.teamName, data[r][3], data[r][4], 'YES'] });
    }
  }
  // Same rows/values as before, but consecutive rows go out in one setValues each,
  // and the career cache is busted (it wasn't, so the leaderboard/trophy room kept
  // showing the old unmatched rows until the cache expired).
  var i = 0;
  while (i < changes.length) {
    var j = i;
    while (j + 1 < changes.length && changes[j + 1].row === changes[j].row + 1) j++;
    sheet.getRange(changes[i].row, 1, j - i + 1, 6).setValues(changes.slice(i, j + 1).map(function(c) { return c.values; }));
    i = j + 1;
  }
  if (changes.length) { invalidateSheetCache('CareerHistory'); invalidateCareerHistoryCache(); }

  return { ok: true, updated: changes.length, player: player.name };
}

function apiGetMessages(payload) {
  var season = getSeasonConfig().year || new Date().getFullYear();
  var type = payload.type || 'general';
  // Cache chat messages for 30s — players see near-real-time updates without hammering Sheets
  var cache = CacheService.getScriptCache();
  var cacheKey = 'chat_' + type + '_' + season;
  try {
    var cached = cache.get(cacheKey);
    if (cached) return { ok: true, messages: JSON.parse(cached) };
  } catch(e) {}
  var messages = sheetToObjects(SHEET_NAMES.MESSAGES)
    .filter(function(m) { return String(m.season) === String(season) && m.type === type; })
    .sort(function(a, b) { return new Date(a.postedAt) - new Date(b.postedAt); });
  try { cache.put(cacheKey, JSON.stringify(messages), 30); } catch(e) {}
  return { ok: true, messages: messages };
}

function apiPostMessage(payload) {
  var player = sheetToObjects(SHEET_NAMES.PLAYERS).find(function(p) { return p.id === payload.playerId; });
  if (!player || !player.active) return { ok: false, error: 'Player not found.' };

  var type = payload.type || 'general';
  // only admins can post commissioner messages
  if (type === 'commissioner' && !(player.isAdmin === true || player.isAdmin === 'TRUE')) {
    return { ok: false, error: 'Only commissioners can post to the commissioner channel.' };
  }

  var message = String(payload.message || '').trim();
  if (!message || message.length > 1000) return { ok: false, error: 'Message must be 1-1000 characters.' };

  var season = getSeasonConfig().year || new Date().getFullYear();
  var messageId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  var postedAt = new Date().toISOString();

  appendObject(SHEET_NAMES.MESSAGES, {
    messageId: messageId,
    type: type,
    playerId: player.id,
    playerName: player.name,
    teamName: player.teamName,
    message: message,
    postedAt: postedAt,
    season: season
  });
  // Bust chat cache AFTER the append (busting before it let a concurrent reader
  // re-cache the list without the new message for 30s)
  try { CacheService.getScriptCache().remove('chat_' + type + '_' + season); } catch(e) {}
  markFrontDoorStale_();

  // send push notification: commissioner messages notify everyone (using the same
  // shared broadcast helper as board-posted alerts); general messages only notify
  // players who haven't explicitly turned off chat notifications via their chatNotif
  // preference (default 'on' -- opt-out, not opt-in).
  // This replaces a call to notifyNewMessage(), a function that was referenced here
  // but never actually defined anywhere in the project — every commissioner message
  // silently failed to notify before this fix.
  try {
    if (type === 'commissioner') {
      sendPushToAllPlayers('📢 ' + player.teamName + ' (Commissioner)', message.slice(0, 120));
    } else {
      var optedIn = sheetToObjects(SHEET_NAMES.PLAYERS).filter(function(p) {
        return p.active && p.id !== player.id && p.fcmToken && String(p.fcmToken).trim() !== '' && p.chatNotif !== 'off';
      });
      var chatMsgs = [];
      optedIn.forEach(function(p) {
        String(p.fcmToken).split(',').map(function(t) { return t.trim(); }).filter(Boolean).forEach(function(token) {
          chatMsgs.push({ token: token, title: '💬 ' + player.teamName, body: message.slice(0, 120), data: { type: 'chat' } });
        });
      });
      sendFcmBatch_(chatMsgs);
    }
  } catch(e) { Logger.log('Message notification error: ' + e.message); }

  return { ok: true, messageId: messageId, postedAt: postedAt };
}

function apiAdminRecordBowlWinners(payload) {
  requireAdmin(payload);
  var year = Number(payload.year || getSeasonConfig().year || new Date().getFullYear());

  // Compute Bowl Bonanza standings from BowlPicks + BowlGames
  var players = sheetToObjects(SHEET_NAMES.PLAYERS).filter(function(p) { return p.active === true || p.active === 'TRUE'; });
  var bowlGames = sheetToObjects('BowlGames').filter(function(g) { return g.isFinal === true || g.isFinal === 'TRUE'; });
  var bowlPicks = sheetToObjects(SHEET_NAMES.BOWL_PICKS);
  var bowlChamp = sheetToObjects(SHEET_NAMES.BOWL_CHAMPION);

  // Build game result map
  var gameResults = {};
  bowlGames.forEach(function(g) {
    var awayScore = Number(g.finalAwayScore) || 0;
    var homeScore = Number(g.finalHomeScore) || 0;
    gameResults[g.gameId] = awayScore > homeScore ? g.awayTeam : g.homeTeam;
  });

  // Score each player
  var standings = players.map(function(player) {
    var myPicks = bowlPicks.filter(function(pk) { return pk.playerId === player.id; });
    var pts = 0;
    myPicks.forEach(function(pk) {
      var winner = gameResults[pk.gameId];
      if (!winner) return;
      var isUpset = pk.isUpset === true || pk.isUpset === 'TRUE';
      var game = bowlGames.find(function(g) { return g.gameId === pk.gameId; });
      if (isUpset) {
        var dog = game && (game.favorite === game.homeTeam ? game.awayTeam : game.homeTeam);
        if (String(pk.pickedTeam) === winner && winner === dog) pts += Number(game.spread) || 0;
      } else {
        if (String(pk.pickedTeam) === winner) pts += 1;
      }
    });
    // bonus for champion pick
    var champ = bowlChamp.find(function(c) { return c.playerId === player.id; });
    if (champ) {
      var champGame = bowlGames.find(function(g) { return g.isChampionship === true || g.isChampionship === 'TRUE'; });
      if (champGame && gameResults[champGame.gameId] === String(champ.teamPicked)) pts += 5;
    }
    return { playerId: player.id, name: player.name, teamName: player.teamName, points: pts };
  }).sort(function(a, b) { return b.points - a.points; });

  // Write top 3 to BowlWinners
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var bw = ss.getSheetByName('BowlWinners');
  if (!bw) {
    bw = ss.insertSheet('BowlWinners');
    bw.appendRow(['playerId','name','teamName','year','position','points']);
  }

  // Remove existing for this year
  var bwData = bw.getDataRange().getValues();
  var bwYearIdx = bwData[0].indexOf('year');
  var keepRows = [bwData[0]];
  for (var i = 1; i < bwData.length; i++) {
    if (Number(bwData[i][bwYearIdx]) !== year) keepRows.push(bwData[i]);
  }
  bw.clearContents();
  bw.getRange(1, 1, keepRows.length, keepRows[0].length).setValues(keepRows);

  // Write top 3
  var top3 = standings.slice(0, 3).map(function(s, idx) {
    return [s.playerId, s.name, s.teamName, year, idx + 1, s.points];
  });
  if (top3.length > 0) bw.getRange(bw.getLastRow() + 1, 1, top3.length, 6).setValues(top3);

  return { ok: true, winners: top3.map(function(r) { return { position: r[4], teamName: r[2], points: r[5] }; }) };
}

// ---- UpsetHistory index (Trophy Room) ----------------------------------------
// UpsetHistory is the biggest history tab (5k+ rows) and the Trophy Room used to read
// all of it on every visit to count one player's upsets. It only changes when a week
// is wrapped up, so it is summarised once per team name and cached:
//   { NORM: { a: attempts, h: hits, p: upsetPts, b: biggest hit {team, spread, year,
//     week, pts, i: row order}, w: { year: [weeks with a row] } } }
// Busted by invalidateSheetCache('UpsetHistory') (the week wrap-up) and onSheetChange.
var UPSET_INDEX_KEY = 'upsetIndex_v1';
function trophyNorm_(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g,'').trim(); }

function getUpsetHistoryIndex_() {
  var cache = CacheService.getScriptCache();
  try {
    var cached = cacheGetChunked_(cache, UPSET_INDEX_KEY);
    if (cached) return JSON.parse(cached);
  } catch (e) {}
  var genBefore = cache.get('upsetIndexGen') || '0';
  var idx = {};
  sheetToObjects(SHEET_NAMES.UPSET_HISTORY).forEach(function(r, i) {
    var n = trophyNorm_(r.teamName);
    var e = idx[n] || (idx[n] = { a: 0, h: 0, p: 0, b: null, w: {} });
    var yr = Number(r.year);
    (e.w[yr] = e.w[yr] || []).push(Number(r.week));
    if (r.attempted === true || r.attempted === 'TRUE') e.a++;
    e.p += Number(r.upsetPts) || 0;
    if (r.hit === true || r.hit === 'TRUE') {
      e.h++;
      var pts = Number(r.upsetPts);
      if (!e.b || pts > e.b.pts) e.b = { team: r.upsetPick, spread: Number(r.spread), year: yr, week: Number(r.week), pts: pts, i: i };
    }
  });
  try {
    if ((cache.get('upsetIndexGen') || '0') === genBefore) {
      cachePutChunked_(cache, UPSET_INDEX_KEY, JSON.stringify(idx), sheetChangeWatched_() ? 21600 : 360);
    }
  } catch (e) {}
  return idx;
}

function invalidateUpsetHistoryIndex_() {
  try {
    var cache = CacheService.getScriptCache();
    cache.put('upsetIndexGen', String(Date.now()) + Math.random().toString(36).slice(2, 6), 21600);
    cache.remove(UPSET_INDEX_KEY + '_n');
  } catch (e) {}
  markFrontDoorStale_();
}

// Reads one player's avatar without loading every player's photo (the Players tab
// is mostly base64 avatars): header row + id column + the one cell.
function readPlayerAvatar_(playerId) {
  var sheet = getSheet(SHEET_NAMES.PLAYERS);
  if (!sheet) return '';
  var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return '';
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var idCol = headers.indexOf('id'), avCol = headers.indexOf('avatar');
  if (idCol < 0 || avCol < 0) return '';
  var ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === playerId) return sheet.getRange(i + 2, avCol + 1).getValue() || '';
  }
  return '';
}

function apiGetTrophyRoom(payload) {
  var targetPlayerId = payload.playerId;
  if (!targetPlayerId) return { ok: false, error: 'Missing playerId.' };

  // CacheService cache — 5 min TTL, busted on bio/profile updates
  // (v4: this season's Upset Specials are no longer double-counted)
  var cacheKey = 'trophy_v4_' + targetPlayerId;
  try {
    var cached = CacheService.getScriptCache().get(cacheKey);
    if (cached) {
      var parsed = JSON.parse(cached);
      if (parsed && parsed.ok) return parsed;
    }
  } catch(e) {}

  // Players, season and games come from the cached shared state (the Players tab is
  // mostly avatars; only this player's is read, below)
  var shared = getSharedState_();
  var player  = (shared.players || []).find(function(p) { return p.id === targetPlayerId; });
  if (!player) return { ok: false, error: 'Player not found.' };

  var norm = trophyNorm_;

  // Build myTeamNorms from NameClaims only — no CareerHistory scan needed
  // Current team name + any approved claimed names
  var playerNorm = norm(player.teamName);
  var myTeamNorms = [playerNorm];
  try {
    sheetToObjects(SHEET_NAMES.NAME_CLAIMS)
      .filter(function(r) { return r.playerId === targetPlayerId && r.status === 'approved'; })
      .forEach(function(r) {
        var n = norm(r.claimedTeamName);
        if (n && myTeamNorms.indexOf(n) < 0) myTeamNorms.push(n);
      });
  } catch(e) {}

  // Regular season trophies — read from SeasonTrophies sheet (pre-archived)
  // Run apiAdminArchiveSeasonTrophies to backfill all historical years.
  // No more scanning CareerHistory for ranking — fast single sheet read.
  var trophies = [];
  var champYears = [];
  try {
    sheetToObjects(SHEET_NAMES.SEASON_TROPHIES)
      .filter(function(r) { return r.playerId === targetPlayerId; })
      .forEach(function(r) {
        var pos = Number(r.position);
        var yr = Number(r.year);
        trophies.push({ year: yr, position: pos, points: Number(r.points) });
        if (pos === 1) champYears.push(yr);
      });
  } catch(e) {}
  trophies.sort(function(a, b) { return a.year - b.year; });
  champYears.sort(function(a, b) { return a - b; });

  // Bowl trophies
  var bowlTrophies = [];
  try {
    sheetToObjects('BowlWinners').filter(function(r) { return r.playerId === targetPlayerId; })
      .forEach(function(r) {
        bowlTrophies.push({ year: Number(r.year), position: Number(r.position), points: Number(r.points), type: 'bowl' });
      });
  } catch(e) {}

  // Upset stats from UpsetHistory — match any teamName this player has ever used
  var config = {};
  (shared.season || []).forEach(function(r) { config[r.key] = r.value; });
  var currentYear = Number(config.year || new Date().getFullYear());
  var upsetIndex = getUpsetHistoryIndex_();
  var upsetAttempts = 0, upsetHits = 0, totalUpsetPts = 0, best = null;
  var weeksInHistory = {}; // this season's weeks already wrapped up into UpsetHistory
  myTeamNorms.forEach(function(n) {
    var e = upsetIndex[n];
    if (!e) return;
    upsetAttempts += e.a; upsetHits += e.h; totalUpsetPts += e.p;
    if (e.b && (!best || e.b.pts > best.pts || (e.b.pts === best.pts && e.b.i < best.i))) best = e.b;
    (e.w[currentYear] || []).forEach(function(wk) { weeksInHistory[wk] = true; });
  });
  var biggestUpset = best ? { team: best.team, spread: best.spread, year: best.year, week: best.week } : null;

  // Current season — only weeks NOT yet in UpsetHistory. The week wrap-up
  // (checkGameFinalNotifications) writes each finished week there, so counting those
  // weeks' picks again double-counted every Upset Special of this season.
  // Picks come from the cached picks bundle (not a read of the whole Picks tab).
  var games = shared.games || [];
  var packed = getPicksBundle_(currentWeekOf_(shared)).picksCompact;
  var myPIdx = packed.p.indexOf(String(targetPlayerId));
  var myUpsettPicks = myPIdx < 0 ? [] : packed.r.filter(function(row) {
    return row[1] === myPIdx && (row[4] & 1) && !weeksInHistory[row[0]];
  }).map(function(row) { return { week: row[0], gameId: packed.g[row[2]], pickedTeam: packed.t[row[3]] }; });
  myUpsettPicks.forEach(function(pk) {
    var game = games.find(function(g) { return g.gameId === pk.gameId && (g.isFinal === true || g.isFinal === 'TRUE'); });
    if (!game) return;
    upsetAttempts++;
    var awayS = Number(game.finalAwayScore)||0, homeS = Number(game.finalHomeScore)||0;
    var winner = awayS > homeS ? game.awayTeam : game.homeTeam;
    var dog = game.favorite === game.homeTeam ? game.awayTeam : game.homeTeam;
    if (winner === dog && String(pk.pickedTeam) === dog) {
      upsetHits++;
      var pts = Number(game.spread)||0;
      totalUpsetPts += pts;
      if (!biggestUpset || pts > biggestUpset.spread) biggestUpset = { team: pk.pickedTeam, spread: pts, year: currentYear, week: Number(pk.week) };
    }
  });

  // Perfect weeks — read from PerfectWeeks sheet only (pre-archived by apiAdminArchivePerfectWeeks)
  // No more scanning all picks/games — O(1) sheet read instead of O(players*weeks*games)
  var perfectWeeks = [];
  try {
    sheetToObjects(SHEET_NAMES.PERFECT_WEEKS)
      .filter(function(r) {
        if (r.playerId && r.playerId === targetPlayerId) return true;
        if (!r.playerId || r.playerId === '') return myTeamNorms.indexOf(norm(r.teamName)) >= 0;
        return false;
      })
      .forEach(function(r) { perfectWeeks.push({ week: Number(r.week), year: Number(r.year), games: Number(r.totalGames) || 10 }); });
  } catch(e) {}

  // League perfect week count — just the sheet length
  var pwAll = [];
  try { pwAll = sheetToObjects(SHEET_NAMES.PERFECT_WEEKS); } catch(e) {}
  var leaguePerfectCount = pwAll.length;

  // Bio
  var bio = sheetToObjects(SHEET_NAMES.BIOS).find(function(b) { return b.playerId === targetPlayerId; }) || null;

  var result = {
    ok: true,
    player: { id: player.id, name: player.name, teamName: player.teamName, avatar: player.hasAvatar ? readPlayerAvatar_(player.id) : '', joinedSeason: player.joinedSeason || '', memberSince: player.memberSince || player.joinedSeason || '' },
    trophies: trophies, bowlTrophies: bowlTrophies,
    upsetAttempts: upsetAttempts, upsetHits: upsetHits,
    totalUpsetPts: Math.round(totalUpsetPts * 10) / 10,
    biggestUpset: biggestUpset, perfectWeeks: perfectWeeks,
    leaguePerfectCount: leaguePerfectCount, champYears: champYears, bio: bio
  };
  // Cache for 5 minutes
  try {
    var str = JSON.stringify(result);
    if (str.length < 90000) CacheService.getScriptCache().put(cacheKey, str, 300);
  } catch(e) {}
  return result;
}


function apiSaveBio(payload) {
  var playerId = payload.playerId;
  if (!playerId) return { ok: false, error: 'Missing playerId.' };
  var player = sheetToObjects(SHEET_NAMES.PLAYERS).find(function(p) { return p.id === playerId; });
  if (!player) return { ok: false, error: 'Player not found.' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAMES.BIOS);
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h) { return String(h).trim(); });
  var idIdx = headers.indexOf('playerId');

  var fields = ['hometown','college','favTeam','firstGame','favGame','favPlayer','favUpset','strategy','occupation','funFact','email','bioText','photoUrl'];
  var updates = { playerId: playerId, teamName: player.teamName, updatedAt: new Date().toISOString() };
  fields.forEach(function(f) { if (payload[f] !== undefined) updates[f] = payload[f]; });

  // find existing row
  var found = false;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]).trim() === playerId) {
      headers.forEach(function(h, idx) { if (updates[h] !== undefined) sheet.getRange(i+1, idx+1).setValue(updates[h]); });
      found = true;
      break;
    }
  }
  if (!found) appendObject(SHEET_NAMES.BIOS, updates);
  invalidateStateCache();
  invalidateTrophyCache(playerId);
  return { ok: true };
}

function apiGenerateBio(payload) {
  // This is called server-side to generate bio via Claude API
  var playerId = payload.playerId;
  var answers  = payload.answers;
  var teamName = payload.teamName || '';
  var joinedSeason = payload.joinedSeason || 'its founding';

  if (!answers || Object.keys(answers).length < 3) return { ok: false, error: 'Not enough answers to generate a bio.' };

  // API key stored in Script Properties — set it once via:
  // PropertiesService.getScriptProperties().setProperty('ANTHROPIC_API_KEY', 'sk-ant-...')
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) return { ok: false, error: 'Anthropic API key not configured. Ask the commissioner to set it up.' };

  var prompt = 'You are writing a fun, witty, third-person bio paragraph for a fantasy college football pick\'em league called Upset Special. '
    + 'The player has been in this league since ' + joinedSeason + '. '
    + 'Write ONE paragraph (3-5 sentences) in a warm, slightly irreverent sports-bar voice. '
    + 'Use their answers to craft something personal and entertaining. '
    + 'Do not use their real name — refer to them only by their team name "' + teamName + '". '
    + 'Here are their answers:\n'
    + Object.keys(answers).map(function(k) { return '- ' + k + ': ' + answers[k]; }).join('\n')
    + '\nWrite only the bio paragraph, no quotes or preamble.';

  try {
    var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      }),
      muteHttpExceptions: true
    });

    var data = JSON.parse(resp.getContentText());
    if (resp.getResponseCode() !== 200) {
      Logger.log('Anthropic error: ' + resp.getContentText());
      return { ok: false, error: 'AI generation failed. Try again in a moment.' };
    }
    var bioText = data.content && data.content[0] && data.content[0].text ? data.content[0].text.trim() : '';
    if (!bioText) return { ok: false, error: 'Empty response from AI. Try again.' };
    return { ok: true, bioText: bioText };
  } catch(e) {
    Logger.log('generateBio error: ' + e.message);
    return { ok: false, error: 'Could not reach AI service: ' + e.message };
  }
}

function apiRegisterFcmToken(payload) {
  var playerId = payload.playerId;
  var token    = String(payload.token   || '').trim();
  var remove   = payload.remove === true;
  if (!playerId) return { ok: false, error: 'Missing playerId.' };

  // Read current token list for this player
  var players = sheetToObjects(SHEET_NAMES.PLAYERS);
  var player  = players.find(function(p) { return p.id === playerId; });
  if (!player) return { ok: false, error: 'Player not found.' };

  var existing = (player.fcmToken || '').split(',').map(function(t) { return t.trim(); }).filter(Boolean);

  if (remove) {
    // Remove this specific token (or clear all if no token supplied)
    if (token) {
      existing = existing.filter(function(t) { return t !== token; });
    } else {
      existing = [];
    }
  } else {
    if (!token) return { ok: false, error: 'No token provided.' };
    if (!existing.includes(token)) existing.push(token);
    // Cap at 5 tokens per player to keep the field size manageable
    if (existing.length > 5) existing = existing.slice(-5);
  }

  var newTokenStr = existing.join(',');
  var found = updateRowByMatch(SHEET_NAMES.PLAYERS, function(p) { return p.id === playerId; }, { fcmToken: newTokenStr });
  if (!found) return { ok: false, error: 'Failed to update player.' };
  invalidateStateCache();
  return { ok: true, fcmToken: newTokenStr };
}


// ── Push Notification Sender (FCM HTTP v1) ────────────────────────────────────
// Google shut down the legacy FCM Server-Key API in 2024. This uses the current
// HTTP v1 API instead, authenticated via a Firebase service account.
// To enable: Firebase Console → Project Settings → Service Accounts →
// Generate new private key. Paste the ENTIRE downloaded JSON file as a Script
// Property named FCM_SERVICE_ACCOUNT_JSON.

// Exchanges the service account credential for a short-lived OAuth2 access token
// (cached for reuse — tokens are valid up to an hour). Returns null if the
// credential is missing or invalid, logging why.
function getFcmAccessToken_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('fcm_access_token');
  if (cached) return cached;

  var saJson = PropertiesService.getScriptProperties().getProperty('FCM_SERVICE_ACCOUNT_JSON');
  if (!saJson) {
    Logger.log('FCM_SERVICE_ACCOUNT_JSON not set — skipping push notification');
    return null;
  }
  var sa;
  try {
    sa = JSON.parse(saJson);
  } catch (e) {
    Logger.log('FCM_SERVICE_ACCOUNT_JSON is not valid JSON: ' + e.message);
    return null;
  }

  var now = Math.floor(Date.now() / 1000);
  var header = { alg: 'RS256', typ: 'JWT' };
  var claimSet = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  var b64 = function (obj) {
    return Utilities.base64EncodeWebSafe(JSON.stringify(obj)).replace(/=+$/, '');
  };
  var toSign = b64(header) + '.' + b64(claimSet);
  var signatureBytes = Utilities.computeRsaSha256Signature(toSign, sa.private_key);
  var signature = Utilities.base64EncodeWebSafe(signatureBytes).replace(/=+$/, '');
  var jwt = toSign + '.' + signature;

  var resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt },
    muteHttpExceptions: true
  });

  if (resp.getResponseCode() !== 200) {
    Logger.log('FCM token exchange failed: ' + resp.getContentText());
    return null;
  }
  var data = JSON.parse(resp.getContentText());
  cache.put('fcm_access_token', data.access_token, Math.min((data.expires_in || 3600) - 60, 3600));
  return data.access_token;
}

// Sends one push message to one FCM token via HTTP v1. For more than one token use
// sendFcmBatch_, which sends them in parallel. Returns true/false for success.
function sendFcmV1_(token, title, body, dataObj) {
  return sendFcmBatch_([{ token: token, title: title, body: body, data: dataObj }]) === 1;
}

// Sends many push messages IN PARALLEL via UrlFetchApp.fetchAll (chunks of 50).
// Previously every caller looped sendFcmV1_ one token at a time -- ~0.3-1s each,
// so a chat post to ~40 players (often 2 devices each) took 30-60s and timed out.
// messages: [{ token, title, body, data }]. Returns the number sent successfully.
function sendFcmBatch_(messages) {
  if (!messages || messages.length === 0) return 0;
  var accessToken = getFcmAccessToken_();
  if (!accessToken) return 0;

  // project_id parsed once per call (was re-read and re-parsed for every single token)
  var saJson = PropertiesService.getScriptProperties().getProperty('FCM_SERVICE_ACCOUNT_JSON');
  var projectId;
  try { projectId = JSON.parse(saJson).project_id; } catch (e) { return 0; }
  var url = 'https://fcm.googleapis.com/v1/projects/' + projectId + '/messages:send';

  var requests = messages.map(function(m) {
    // FCM v1 requires every data value to be a string
    var stringData = {};
    Object.keys(m.data || {}).forEach(function (k) { stringData[k] = String(m.data[k]); });
    return {
      url: url,
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + accessToken },
      payload: JSON.stringify({
        message: {
          token: m.token,
          notification: { title: m.title, body: m.body },
          webpush: { notification: { icon: '/UpsetSpecial/icon-192.png' } },
          data: stringData
        }
      }),
      muteHttpExceptions: true
    };
  });

  var sent = 0;
  for (var i = 0; i < requests.length; i += 50) {
    var chunk = requests.slice(i, i + 50);
    var responses;
    try { responses = UrlFetchApp.fetchAll(chunk); } catch (e) { Logger.log('FCM fetchAll error: ' + e.message); continue; }
    responses.forEach(function(resp, j) {
      if (resp.getResponseCode() === 200) { sent++; return; }
      Logger.log('FCM v1 send failed (token ' + String(messages[i + j].token).slice(0, 12) + '...): ' + resp.getContentText());
    });
  }
  return sent;
}

function sendPushToAllPlayers(title, body) {
  try {
    var players = sheetToObjects(SHEET_NAMES.PLAYERS).filter(function(p) {
      return p.active && p.fcmToken && String(p.fcmToken).trim() !== '';
    });
    if (players.length === 0) return;

    // Collect all unique tokens
    var allTokens = [];
    players.forEach(function(p) {
      String(p.fcmToken).split(',').forEach(function(t) {
        t = t.trim();
        if (t && allTokens.indexOf(t) < 0) allTokens.push(t);
      });
    });
    if (allTokens.length === 0) return;

    var sent = sendFcmBatch_(allTokens.map(function(token) {
      return { token: token, title: title, body: body, data: { type: 'general' } };
    }));
    Logger.log('FCM v1: sent to ' + sent + '/' + allTokens.length + ' tokens');
  } catch(e) {
    Logger.log('sendPushToAllPlayers error: ' + e.message);
  }
}

function sendPickReminder(week) {
  try {
    sendPushToAllPlayers(
      '🏈 Pick Reminder — Week ' + week,
      'The board is posted! Lock in your picks before kickoff.'
    );
  } catch(e) { Logger.log('sendPickReminder error: ' + e.message); }
}

function sendResultsNotification(week) {
  try {
    sendPushToAllPlayers(
      '🏆 Week ' + week + ' Results',
      'Results are in! Check the standings.'
    );
  } catch(e) { Logger.log('sendResultsNotification error: ' + e.message); }
}

// One-off diagnostic: run directly from the Apps Script editor after adding
// FCM_SERVICE_ACCOUNT_JSON to Script Properties. Confirms the OAuth2 token
// exchange works and reports how many players currently have a token on file
// (without actually sending anything, since there's likely no one to notify yet).
function debugFcmSetup() {
  var token = getFcmAccessToken_();
  if (!token) {
    Logger.log('FAILED — no access token. Check that FCM_SERVICE_ACCOUNT_JSON is set and is valid JSON from Firebase.');
    return;
  }
  Logger.log('OAuth2 token exchange succeeded — credential is valid.');
  var playersWithTokens = sheetToObjects(SHEET_NAMES.PLAYERS).filter(function(p) {
    return p.fcmToken && String(p.fcmToken).trim() !== '';
  });
  Logger.log(playersWithTokens.length + ' player(s) currently have an FCM token on file: ' +
    playersWithTokens.map(function(p) { return p.teamName; }).join(', '));
  Logger.log('To send yourself a real test push, enable notifications in the app first (Profile), then run testSendPushToMe().');
}

// Run this AFTER enabling notifications in the app under your own account, to send
// yourself one real test push and confirm delivery end-to-end.
function testSendPushToMe() {
  var targetTeamName = 'HARBAUGH4PRESIDENT';
  var player = sheetToObjects(SHEET_NAMES.PLAYERS).find(function(p) {
    return String(p.teamName).trim().toUpperCase() === targetTeamName;
  });
  if (!player) {
    Logger.log('No player found with team name ' + targetTeamName + '.');
    return;
  }
  if (!player.fcmToken || String(player.fcmToken).trim() === '') {
    Logger.log(targetTeamName + ' has no FCM token yet — enable notifications in the app (Profile) first.');
    return;
  }
  var tokens = String(player.fcmToken).split(',').map(function(t) { return t.trim(); }).filter(Boolean);
  var ok = sendFcmV1_(tokens[0], 'Test push', 'If you see this, FCM v1 is working!', { type: 'test' });
  Logger.log(ok ? ('Sent to ' + player.teamName + ' — check that device for the notification.') : 'Send failed — check the log above for the error.');
}

function apiHelpChat(payload) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) return { ok: false, error: 'AI not configured — contact the commissioner.' };

  var messages = payload.messages;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: 'No messages provided.' };
  }
  // Sanitise — only allow role/content fields, max 6 messages (faster), max 300 chars each
  var cleaned = messages.slice(-6).map(function(m) {
    return {
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 500)
    };
  });

  var system = 'You are the Upset Special League help assistant. Answer questions about this fantasy college football pick\'em app concisely (2-4 sentences max).\n\n'
    + 'Key facts:\n'
    + '- Weekly college football pick\'em league running since 2016, 43 players, $100 entry\n'
    + '- Each week players pick one Upset Special (underdog to win outright — earn the point spread as bonus pts if correct)\n'
    + '- All other picks are straight picks against the spread (1 pt each for correct)\n'
    + '- Perfect Week = 10/10 correct picks = bullseye trophy in Trophy Room\n'
    + '- Seasons run alongside the college football regular season (approx Weeks 1-13)\n'
    + '- App is a PWA installed from Safari on iOS or Chrome on Android\n'
    + '- Trophy Room shows 3D spinning trophies for regular season finishes (1st/2nd/3rd) and Bowl Bonanza\n'
    + '- Players can claim previous team names to merge historical stats\n'
    + '- Commissioner is Jeff Wilkerson; app built and maintained by Tony Edmonds\n'
    + '- Push notifications require the app to be installed as a PWA first\n'
    + '- Go to Profile to change PIN, upload avatar, fill out bio, claim names, enable notifications\n'
    + '- Standings → History tab for all-time leaderboard and year-by-year results\n\n'
    + 'If you don\'t know something specific, say so and suggest contacting Jeff (commissioner) or Tony (app).';

  try {
    var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: system,
        messages: cleaned
      }),
      muteHttpExceptions: true
    });
    var data = JSON.parse(resp.getContentText());
    if (resp.getResponseCode() !== 200) {
      Logger.log('helpChat Anthropic error: ' + resp.getContentText());
      return { ok: false, error: 'AI service error — try again in a moment.' };
    }
    var answer = data.content && data.content[0] ? data.content[0].text.trim() : '';
    if (!answer) return { ok: false, error: 'Empty response — try again.' };
    return { ok: true, answer: answer };
  } catch(e) {
    Logger.log('helpChat error: ' + e.message);
    return { ok: false, error: 'Could not reach AI service.' };
  }
}

function apiDeleteMessage(payload) {
  requireAdmin(payload);
  var messageId = payload.messageId;
  if (!messageId) return { ok: false, error: 'Missing messageId.' };
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.MESSAGES);
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h) { return String(h).trim(); });
  var idIdx = headers.indexOf('messageId');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]).trim() === messageId) {
      sheet.deleteRow(i + 1);
      // bust the chat cache so the deleted message disappears immediately (was up to 30s)
      try {
        var season = getSeasonConfig().year || new Date().getFullYear();
        CacheService.getScriptCache().removeAll(['chat_general_' + season, 'chat_commissioner_' + season]);
      } catch(e) {}
      markFrontDoorStale_();
      return { ok: true };
    }
  }
  return { ok: false, error: 'Message not found.' };
}

function apiAdminTogglePaid(payload) {
  requireAdmin(payload);
  var playerId = payload.playerId;
  var isPaid   = !!payload.isPaid;
  if (!playerId) return { ok: false, error: 'Missing playerId.' };
  updateRowByMatch(SHEET_NAMES.PLAYERS, function(r) { return r.id === playerId; }, { isPaid: isPaid });
  invalidateStateCache();
  return { ok: true, isPaid: isPaid };
}

function apiGetAllEspnScores(payload) {
  // Every viewer of the Scores tab used to trigger its own uncached ESPN fetch.
  // One shared 45s cache serves everyone with effectively-live scores.
  var cache = CacheService.getScriptCache();
  try {
    var hit = cacheGetChunked_(cache, 'allEspnScores');
    if (hit) return { ok: true, games: JSON.parse(hit) };
  } catch(e) {}
  try {
    var events = fetchEspnScoreboard();
    var games = events.map(function(ev) {
      var comp = ev.competitions && ev.competitions[0];
      if (!comp) return null;
      var competitors = comp.competitors || [];
      var home = competitors.find(function(c) { return c.homeAway === 'home'; });
      var away = competitors.find(function(c) { return c.homeAway === 'away'; });
      if (!home || !away) return null;

      var status = comp.status && comp.status.type;
      var statusName = status ? (status.completed ? 'final' : status.name === 'STATUS_IN_PROGRESS' ? 'live' : 'upcoming') : 'upcoming';

      var line = extractEspnLine(ev, comp, home, away);

      return {
        espnEventId: ev.id,
        awayTeam: away.team && away.team.displayName || '',
        homeTeam: home.team && home.team.displayName || '',
        favorite: line.favorite || '',
        spread:   line.spread || 0,
        awayScore: away.score || '',
        homeScore: home.score || '',
        kickoff: comp.startDate || '',
        status: statusName,
        clock: (comp.status && comp.status.displayClock) || '',
        period: (comp.status && comp.status.period) || ''
      };
    }).filter(Boolean);

    // don't cache an empty list (likely an ESPN hiccup) -- let the next caller retry
    if (games.length) { try { cachePutChunked_(cache, 'allEspnScores', JSON.stringify(games), 45); } catch(e) {} }
    return { ok: true, games: games };
  } catch(e) {
    return { ok: false, error: e.message, games: [] };
  }
}

// ── CareerHistory Fixes ───────────────────────────────────────────────────────

// Fix #1 & #3 combined: Rebuild CareerHistory from UpsetHistory for all years
// This ensures unlinked players appear in CareerHistory (for correct trophy detection)
// AND fixes point mismatches by recomputing from the source data.
// Run once from Apps Script editor, then re-run the audit to confirm clean.
function rebuildCareerHistoryFromUpsetHistory() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var uhRows = sheetToObjects('UpsetHistory');
  var players = sheetToObjects('Players');

  // Build playerId lookup by teamName (uppercase)
  var playerMap = {};
  players.forEach(function(p) {
    if (p.teamName) playerMap[String(p.teamName).trim().toUpperCase()] = { id: String(p.id), name: p.name };
  });

  // Also check NameClaims for approved linkages (claimedTeamName -> playerId)
  var claims = [];
  try { claims = sheetToObjects('NameClaims'); } catch(e) {}
  claims.filter(function(c) { return c.status === 'approved'; }).forEach(function(c) {
    var tn = String(c.claimedTeamName || '').trim().toUpperCase();
    if (!playerMap[tn]) {
      playerMap[tn] = { id: String(c.playerId), name: c.playerName };
    }
  });

  // Sum weekPts per teamName per year from UpsetHistory
  var totals = {}; // key: "TEAMNAME|year" -> { teamName, playerId, name, year, points }
  uhRows.forEach(function(r) {
    var tn  = String(r.teamName || '').trim().toUpperCase();
    var yr  = Number(r.year);
    var pts = Number(r.weekPts) || 0;
    if (!tn || !yr) return;
    var key = tn + '|' + yr;
    if (!totals[key]) {
      var linked = playerMap[tn] || null;
      totals[key] = {
        teamName: String(r.teamName).trim(),
        playerId: linked ? linked.id : '',
        name:     linked ? linked.name : '',
        year:     yr,
        points:   0
      };
    }
    totals[key].points += pts;
  });

  // Round to 1 decimal
  Object.values(totals).forEach(function(t) {
    t.points = Math.round(t.points * 10) / 10;
  });

  // Get current season year — don't overwrite current season rows
  var currentYear = Number(getSeasonConfig().year);

  // Read existing CareerHistory — keep current season rows, replace everything else
  var chSheet = ss.getSheetByName('CareerHistory');
  if (!chSheet) {
    chSheet = ss.insertSheet('CareerHistory');
    chSheet.appendRow(['playerId','name','teamName','year','points','matched']);
  }
  var existing = chSheet.getDataRange().getValues();
  var headers  = existing[0];
  var yearIdx  = headers.indexOf('year');

  // Keep only current season rows (they come from live data, not UpsetHistory)
  var keepRows = [headers];
  for (var i = 1; i < existing.length; i++) {
    if (Number(existing[i][yearIdx]) === currentYear) keepRows.push(existing[i]);
  }

  // Build replacement rows from totals for all historical years
  var newRows = Object.values(totals)
    .filter(function(t) { return t.year !== currentYear; })
    .sort(function(a,b) { return a.year - b.year || b.points - a.points; })
    .map(function(t) {
      return [t.playerId, t.name, t.teamName, t.year, t.points, t.playerId ? 'YES' : ''];
    });

  var allRows = keepRows.concat(newRows);
  chSheet.clearContents();
  chSheet.getRange(1, 1, allRows.length, 6).setValues(allRows);
  invalidateCareerHistoryCache();

  Logger.log('CareerHistory rebuilt: ' + newRows.length + ' historical rows + ' + (keepRows.length - 1) + ' current season rows.');
  Logger.log('Run runCareerHistoryAudit() to verify.');
}

// Suppress current season from audit mismatch report (UH=0 is expected for current year)


function apiAdminAuditCareerHistory() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var currentYear = Number(getSeasonConfig().year);

  // Load all data
  var careerRows = getCareerHistoryCached();
  var upsetRows  = sheetToObjects('UpsetHistory');

  // Build UpsetHistory sums: key = "teamName|year" -> total weekPts
  var uhSums = {};
  upsetRows.forEach(function(r) {
    var tn   = String(r.teamName || '').trim().toUpperCase();
    var yr   = String(r.year || '').trim();
    var pts  = Number(r.weekPts) || 0;
    if (!tn || !yr) return;
    var key  = tn + '|' + yr;
    uhSums[key] = (uhSums[key] || 0) + pts;
  });

  // Audit each CareerHistory row
  var results = [];
  careerRows.forEach(function(r) {
    var tn      = String(r.teamName || '').trim().toUpperCase();
    var yr      = String(r.year || '').trim();
    var chPts   = Number(r.points) || 0;
    var key     = tn + '|' + yr;
    var uhPts   = uhSums[key] !== undefined ? uhSums[key] : null;
    var diff    = uhPts !== null ? Math.round((chPts - uhPts) * 10) / 10 : null;
    // Current season has no UpsetHistory yet — treat as OK, not a mismatch
    var isCurrent = (Number(yr) === currentYear);
    // If CH > UH by a large margin, likely a comma-vs-period formatting error in UpsetHistory
    // The authoritative source data (master spreadsheet) is trusted over UpsetHistory re-sums
    var likelyFormatError = diff !== null && diff > 10 && chPts > uhPts;
    var status  = isCurrent ? 'CURRENT_SEASON'
                : uhPts === null ? 'NO_UPSET_DATA'
                : Math.abs(diff) < 0.1 ? 'OK'
                : likelyFormatError ? 'UH_FORMAT_ERROR'
                : 'MISMATCH';

    results.push({
      year:       Number(yr),
      teamName:   r.teamName,
      playerId:   r.playerId || '',
      linked:     !!r.playerId,
      chPts:      chPts,
      uhPts:      uhPts,
      diff:       diff,
      status:     status
    });
  });

  // Sort: year asc, then by chPts desc so top finishers are first each year
  results.sort(function(a, b) {
    return a.year - b.year || b.chPts - a.chPts;
  });

  // Build per-year top-3 summary — sorted by chPts, includes unlinked players
  var byYear = {};
  results.forEach(function(r) {
    if (!byYear[r.year]) byYear[r.year] = [];
    byYear[r.year].push(r);
  });

  var yearSummary = [];
  Object.keys(byYear).sort().forEach(function(yr) {
    var rows = byYear[yr].slice().sort(function(a,b){ return b.chPts - a.chPts; });
    yearSummary.push({
      year: Number(yr),
      champion:  rows[0] || null,
      runnerUp:  rows[1] || null,
      third:     rows[2] || null,
      mismatches: rows.filter(function(r){ return r.status === 'MISMATCH'; }).length,
      noData:     rows.filter(function(r){ return r.status === 'NO_UPSET_DATA'; }).length,
      total:      rows.length
    });
  });

  // Overall counts
  var totalMismatches   = results.filter(function(r){ return r.status === 'MISMATCH'; }).length;
  var totalNoData       = results.filter(function(r){ return r.status === 'NO_UPSET_DATA'; }).length;
  var totalOk           = results.filter(function(r){ return r.status === 'OK'; }).length;
  var totalCurrent      = results.filter(function(r){ return r.status === 'CURRENT_SEASON'; }).length;
  var totalFormatErrors = results.filter(function(r){ return r.status === 'UH_FORMAT_ERROR'; }).length;
  var unlinnkedChamps   = yearSummary.filter(function(y){ return y.champion && !y.champion.linked && Number(y.year) !== currentYear; }).length;

  return {
    ok: true,
    summary: {
      totalRows:        results.length,
      ok:               totalOk,
      mismatches:       totalMismatches,
      noData:           totalNoData,
      currentSeason:    totalCurrent,
      formatErrors:     totalFormatErrors,
      unlinkedChampions: unlinnkedChamps
    },
    yearSummary:  yearSummary,
    allRows:      results
  };
}

// Run this from Apps Script editor to get a full audit log
function runCareerHistoryAudit() {
  var result = apiAdminAuditCareerHistory();
  Logger.log('=== CAREER HISTORY AUDIT ===');
  Logger.log('Total rows: ' + result.summary.totalRows);
  Logger.log('OK: ' + result.summary.ok);
  Logger.log('MISMATCHES (real errors): ' + result.summary.mismatches);
  Logger.log('UH FORMAT ERRORS (source data trusted): ' + result.summary.formatErrors);
  Logger.log('NO UPSET DATA: ' + result.summary.noData);
  Logger.log('CURRENT SEASON (excluded): ' + result.summary.currentSeason);
  Logger.log('UNLINKED CHAMPIONS: ' + result.summary.unlinkedChampions);
  Logger.log('');
  Logger.log('=== YEAR BY YEAR TOP 3 ===');
  result.yearSummary.forEach(function(y) {
    var issues = y.mismatches > 0 ? ' (' + y.mismatches + ' mismatches)' : '';
    Logger.log('--- ' + y.year + issues + ' ---');
    ['champion','runnerUp','third'].forEach(function(place, i) {
      var r = y[place];
      if (!r) return;
      var label = ['1st','2nd','3rd'][i];
      var linked = r.linked ? '(linked)' : '(UNLINKED — needs name claim)';
      var status = r.status === 'MISMATCH' ? ' *** MISMATCH: CH=' + r.chPts + ' UH=' + r.uhPts + ' diff=' + r.diff
                 : r.status === 'UH_FORMAT_ERROR' ? ' [UH format error, source trusted]' : '';
      Logger.log('  ' + label + ': ' + r.teamName + ' ' + linked + ' ' + r.chPts + 'pts' + status);
    });
  });
  Logger.log('');
  Logger.log('=== ALL MISMATCHES ===');
  result.allRows.filter(function(r){ return r.status === 'MISMATCH'; }).forEach(function(r) {
    Logger.log(r.year + ' | ' + r.teamName + ' | CH=' + r.chPts + ' UH=' + r.uhPts + ' diff=' + r.diff + (r.linked ? '' : ' UNLINKED'));
  });
}



// Returns all historical team names in CareerHistory that have no playerId
// (i.e. unlinked records) — these are the claimable names
function apiGetClaimableNames(payload) {
  // Read directly from sheet — bypass cache to always get fresh unlinked rows
  var history = [];
  try {
    var chSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('CareerHistory');
    if (chSheet) {
      var chData = chSheet.getDataRange().getValues();
      var chHdrs = chData[0];
      var pidCol = chHdrs.indexOf('playerId');
      var tnCol  = chHdrs.indexOf('teamName');
      var yrCol  = chHdrs.indexOf('year');
      for (var ri = 1; ri < chData.length; ri++) {
        history.push({
          playerId: String(chData[ri][pidCol]||'').trim(),
          teamName: String(chData[ri][tnCol]||'').trim(),
          year:     Number(chData[ri][yrCol])
        });
      }
    }
  } catch(e) { history = getCareerHistoryCached(); }

  var players = sheetToObjects('Players');
  var playerIds = players.map(function(p) { return String(p.id); });
  var unlinked = history.filter(function(r){ return !r.playerId; }).length;
  Logger.log('getClaimableNames: total=' + history.length + ' unlinked=' + unlinked + ' players=' + players.length);

  var claims = [];
  try { claims = sheetToObjects('NameClaims'); } catch(e) {}
  var approvedClaimedNames = claims
    .filter(function(c) { return c.status === 'approved'; })
    .map(function(c) { return String(c.claimedTeamName).toUpperCase(); });

  var seen = {};
  var claimable = [];
  var skippedLinked = 0, skippedApproved = 0;
  history.forEach(function(r) {
    var tn = String(r.teamName || '').trim();
    var pid = String(r.playerId || '').trim();
    if (!tn) return;
    if (pid && playerIds.indexOf(pid) >= 0) { skippedLinked++; return; }
    if (approvedClaimedNames.indexOf(tn.toUpperCase()) >= 0) { skippedApproved++; return; }
    if (seen[tn.toUpperCase()]) return;
    seen[tn.toUpperCase()] = true;
    var rows = history.filter(function(h) { return String(h.teamName || '').trim().toUpperCase() === tn.toUpperCase(); });
    var years = rows.map(function(h) { return Number(h.year); }).filter(Boolean).sort();
    claimable.push({ teamName: tn, years: years, seasons: years.length });
  });

  Logger.log('getClaimableNames: skippedLinked=' + skippedLinked + ' skippedApproved=' + skippedApproved + ' claimable=' + claimable.length);
  claimable.sort(function(a,b) { return a.teamName.localeCompare(b.teamName); });
  return { ok: true, claimable: claimable };
}

function apiSubmitNameClaim(payload) {
  if (!payload.playerId) return { ok: false, error: 'Not logged in.' };
  if (!payload.claimedTeamName) return { ok: false, error: 'No team name provided.' };

  var player = sheetToObjects('Players').find(function(p) { return String(p.id) === String(payload.playerId); });
  if (!player) return { ok: false, error: 'Player not found.' };

  // Check for duplicate pending claim
  var existing = sheetToObjects('NameClaims').filter(function(c) {
    return String(c.playerId) === String(payload.playerId) &&
           String(c.claimedTeamName).toUpperCase() === String(payload.claimedTeamName).toUpperCase() &&
           c.status === 'pending';
  });
  if (existing.length > 0) return { ok: false, error: 'You already have a pending claim for this team name.' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('NameClaims');
  if (!sheet) {
    sheet = ss.insertSheet('NameClaims');
    sheet.appendRow(HEADERS.NameClaims);
  }

  var claimId = 'CLM-' + Date.now();
  var now = new Date().toISOString();
  sheet.appendRow([
    claimId,
    payload.playerId,
    player.name || '',
    player.teamName || '',
    String(payload.claimedTeamName).trim().toUpperCase(),
    String(payload.reason || '').trim(),
    'pending',
    now,
    '',
    ''
  ]);

  // Notify admins via message board
  try {
    var msgSheet = ss.getSheetByName('Messages');
    if (msgSheet) {
      msgSheet.appendRow([
        'MSG-' + Date.now(), 'admin_alert', payload.playerId,
        player.name, player.teamName,
        player.teamName + ' is claiming the historical team name "' + payload.claimedTeamName + '". Review in Admin → Name Claims.',
        now, getSeasonConfig().year
      ]);
    }
  } catch(e) {}

  return { ok: true, claimId: claimId };
}

function apiGetMyNameClaims(payload) {
  if (!payload.playerId) return { ok: false, error: 'Not logged in.' };
  var claims = sheetToObjects('NameClaims').filter(function(c) {
    return String(c.playerId) === String(payload.playerId);
  });
  return { ok: true, claims: claims };
}

function apiAdminGetNameClaims(payload) {
  requireAdminCompat_(payload);
  var claims = sheetToObjects('NameClaims');
  // Enrich with career stats for each claimed name
  var history = getCareerHistoryCached();
  claims.forEach(function(c) {
    var rows = history.filter(function(h) {
      return String(h.teamName || '').trim().toUpperCase() === String(c.claimedTeamName || '').toUpperCase();
    });
    c.years = rows.map(function(h) { return Number(h.year); }).filter(Boolean).sort();
    c.seasons = c.years.length;
  });
  return { ok: true, claims: claims };
}

function apiAdminReviewNameClaim(payload) {
  // was completely unauthenticated -- anyone could approve a claim and relink history
  requireAdminCompat_(payload);
  if (!payload.claimId) return { ok: false, error: 'Missing claimId.' };
  if (!payload.decision || ['approved','rejected'].indexOf(payload.decision) < 0) return { ok: false, error: 'Decision must be approved or rejected.' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('NameClaims');
  if (!sheet) return { ok: false, error: 'NameClaims sheet not found.' };

  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var claimIdCol = headers.indexOf('claimId');
  var statusCol = headers.indexOf('status');
  var reviewedAtCol = headers.indexOf('reviewedAt');
  var reviewedByCol = headers.indexOf('reviewedBy');
  var playerIdCol = headers.indexOf('playerId');
  var claimedNameCol = headers.indexOf('claimedTeamName');

  var rowIdx = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][claimIdCol]) === String(payload.claimId)) { rowIdx = i; break; }
  }
  if (rowIdx < 0) return { ok: false, error: 'Claim not found.' };
  if (String(data[rowIdx][statusCol]) !== 'pending') return { ok: false, error: 'Claim is not pending.' };

  var now = new Date().toISOString();
  sheet.getRange(rowIdx + 1, statusCol + 1).setValue(payload.decision);
  sheet.getRange(rowIdx + 1, reviewedAtCol + 1).setValue(now);
  sheet.getRange(rowIdx + 1, reviewedByCol + 1).setValue(payload.reviewerName || 'Admin');

  if (payload.decision === 'approved') {
    var claimPlayerId = String(data[rowIdx][playerIdCol]);
    var claimedTeamName = String(data[rowIdx][claimedNameCol]).toUpperCase();

    // Link all CareerHistory rows with this teamName to this playerId
    var chSheet = ss.getSheetByName('CareerHistory');
    if (chSheet) {
      var chData = chSheet.getDataRange().getValues();
      var chHeaders = chData[0];
      var chPlayerIdCol = chHeaders.indexOf('playerId');
      var chTeamNameCol = chHeaders.indexOf('teamName');
      var chMatchedCol = chHeaders.indexOf('matched');
      // Update in memory, then write each changed column back in ONE setValues
      // (this used to be 1-2 setValue calls per matching row).
      var chChanged = false;
      for (var j = 1; j < chData.length; j++) {
        var rowTeam = String(chData[j][chTeamNameCol] || '').trim().toUpperCase();
        if (rowTeam === claimedTeamName) {
          chData[j][chPlayerIdCol] = claimPlayerId;
          if (chMatchedCol >= 0) chData[j][chMatchedCol] = 'YES';
          chChanged = true;
        }
      }
      if (chChanged && chPlayerIdCol >= 0) {
        [chPlayerIdCol, chMatchedCol].forEach(function(col) {
          if (col < 0) return;
          chSheet.getRange(2, col + 1, chData.length - 1, 1).setValues(chData.slice(1).map(function(r) { return [r[col]]; }));
        });
      }
    }
    invalidateCareerHistoryCache();

    // Also link UpsetHistory rows
    var uhSheet = ss.getSheetByName('UpsetHistory');
    if (uhSheet) {
      var uhData = uhSheet.getDataRange().getValues();
      var uhHeaders = uhData[0];
      var uhTeamNameCol = uhHeaders.indexOf('teamName');
      var uhPlayerIdCol = uhHeaders.indexOf('playerId');
      if (uhPlayerIdCol >= 0) {
        for (var k = 1; k < uhData.length; k++) {
          var uhTeam = String(uhData[k][uhTeamNameCol] || '').trim().toUpperCase();
          if (uhTeam === claimedTeamName) {
            uhSheet.getRange(k + 1, uhPlayerIdCol + 1).setValue(claimPlayerId);
          }
        }
      }
    }

    // Notify the player via message
    try {
      var msgSheet2 = ss.getSheetByName('Messages');
      if (msgSheet2) {
        msgSheet2.appendRow([
          'MSG-' + Date.now(), 'system', 'system', 'League Admin', 'Admin',
          'Your claim for the historical team name "' + claimedTeamName + '" has been approved! Your career history and stats have been updated.',
          now, getSeasonConfig().year
        ]);
      }
    } catch(e) {}
  }

  return { ok: true, decision: payload.decision };
}

// Cached CareerHistory read — avoids re-reading 200+ rows on every Trophy Room or Leaderboard call.
// CareerHistory only changes at season archive / name-claim review / admin fixes, all
// of which call invalidateCareerHistoryCache(). The old 5-min TTL equalled the keepWarm
// interval, so the cache was almost always expired when keepWarm or a user arrived;
// it's now chunked (no 90KB ceiling) and kept for 6h when manual edits are watched
// (onSheetChange), 6 min otherwise so hand edits still show up about as fast as before.
var CAREER_CACHE_KEY = 'careerHistory_v2';
function getCareerHistoryCached() {
  var cache = CacheService.getScriptCache();
  try {
    var cached = cacheGetChunked_(cache, CAREER_CACHE_KEY);
    if (cached) return JSON.parse(cached);
  } catch(e) {}
  var rows = sheetToObjects('CareerHistory');
  try {
    cachePutChunked_(cache, CAREER_CACHE_KEY, JSON.stringify(rows), sheetChangeWatched_() ? 21600 : 360);
  } catch(e) {}
  return rows;
}

// Call this after any CareerHistory write to invalidate the cache. The shared state
// carries memberSince (derived from CareerHistory), so it is busted too.
function invalidateCareerHistoryCache() {
  try { CacheService.getScriptCache().remove(CAREER_CACHE_KEY + '_n'); } catch(e) {}
  invalidateStateCache();
}

// Run this manually from Apps Script editor if trophy room shows stale data
function clearCareerCache() {
  invalidateCareerHistoryCache();
  invalidateUpsetHistoryIndex_();
  Logger.log('CareerHistory cache cleared.');
}


// ═══════════════════════════════════════════════════════════════════════════════
// RUN THIS DIRECTLY FROM THE APPS SCRIPT EDITOR (not through the web app)
// Editor → select "runSeasonTrophyArchive" → ▶ Run
// This rebuilds the SeasonTrophies sheet correctly from scratch
// ═══════════════════════════════════════════════════════════════════════════════
function runSeasonTrophyArchive() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var norm = function(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g,'').trim(); };

  // Step 1: Delete and recreate SeasonTrophies sheet
  var old = ss.getSheetByName('SeasonTrophies');
  if (old) ss.deleteSheet(old);
  var sheet = ss.insertSheet('SeasonTrophies');
  sheet.appendRow(['playerId','teamName','year','position','points','archivedAt']);

  // Step 2: Read ALL CareerHistory rows (linked and unlinked)
  var ch = ss.getSheetByName('CareerHistory');
  if (!ch) { Logger.log('ERROR: CareerHistory sheet not found'); return; }
  var data = ch.getDataRange().getValues();
  var headers = data[0];
  var rows = data.slice(1).map(function(row) {
    var obj = {};
    headers.forEach(function(h, i) { obj[h] = row[i]; });
    return obj;
  });
  Logger.log('CareerHistory total rows: ' + rows.length);

  // Step 3: Read Players for ID lookup
  var playersSheet = ss.getSheetByName('Players');
  var pData = playersSheet.getDataRange().getValues();
  var pHeaders = pData[0];
  var players = pData.slice(1).map(function(row) {
    var obj = {};
    pHeaders.forEach(function(h, i) { obj[h] = row[i]; });
    return obj;
  });

  // Step 4: Get all years
  var yearsSeen = {};
  rows.forEach(function(r) { if (r.year) yearsSeen[Number(r.year)] = true; });
  var years = Object.keys(yearsSeen).map(Number).sort();
  Logger.log('Years found: ' + years.join(', '));

  var archived = 0;

  years.forEach(function(yr) {
    var yrRows = rows.filter(function(r) { return Number(r.year) === yr; });

    // Deduplicate: one entry per player per year
    // Group by playerId for linked, by norm(teamName) for unlinked
    var byKey = {};
    yrRows.forEach(function(r) {
      var pid = String(r.playerId || '').trim();
      var key = pid ? ('PID_' + pid) : ('NAME_' + norm(r.teamName));
      if (!byKey[key] || Number(r.points) > Number(byKey[key].points)) {
        byKey[key] = r;
      }
    });

    // Remove unlinked entries that match a linked player's current teamName
    var linkedNorms = [];
    Object.values(byKey).forEach(function(r) {
      if (String(r.playerId || '').trim()) linkedNorms.push(norm(r.teamName));
    });
    Object.keys(byKey).forEach(function(k) {
      if (k.indexOf('NAME_') === 0) {
        var n = k.replace('NAME_', '');
        if (linkedNorms.indexOf(n) >= 0) delete byKey[k];
      }
    });

    // Sort all remaining by points descending — these are the TRUE standings
    var sorted = Object.values(byKey).sort(function(a, b) {
      return Number(b.points) - Number(a.points);
    });

    Logger.log('Year ' + yr + ' (' + sorted.length + ' entries) top 5: ' +
      sorted.slice(0,5).map(function(r){ return (r.teamName||'?') + '=' + r.points; }).join(', '));

    // Write top 3 that we can identify with a playerId
    // No existingKeys check needed — sheet was deleted and recreated fresh
    sorted.forEach(function(row, idx) {
      var pos = idx + 1;
      if (pos > 3) return;

      var playerId = String(row.playerId || '').trim();
      if (!playerId) {
        // Try to match by current teamName
        var matched = players.find(function(p) { return norm(p.teamName) === norm(row.teamName); });
        if (matched) playerId = String(matched.id || '').trim();
      }
      if (!playerId) {
        Logger.log('  Position ' + pos + ': ' + row.teamName + ' — no ID match, position consumed');
        return;
      }

      sheet.appendRow([playerId, row.teamName, yr, pos, Number(row.points), new Date().toISOString()]);
      Logger.log('  WRITTEN pos ' + pos + ': ' + row.teamName + ' (' + playerId + ') ' + row.points + ' pts');
      archived++;
    });
  });

  Logger.log('DONE — ' + archived + ' trophy records written');
}

// ── Keep-warm trigger — prevents GAS cold starts AND pre-warms state cache ────
// Run installKeepWarmTrigger() ONCE from the Apps Script editor to set it up.
function keepWarm() {
  var t0 = Date.now();
  try {
    // Reset request-scope caches for this fresh execution
    _ssCache = null;
    _sheetDataCache = {};
    _perfNotes = {};

    // The cached state (if any) answers the live-games check without re-reading the
    // Season + Games sheets, and tells us whether a rebuild is needed at all.
    var cache = CacheService.getScriptCache();
    var cachedShared = null;
    try { var raw = cacheGetChunked_(cache, STATE_CACHE_KEY); if (raw) cachedShared = JSON.parse(raw); } catch (e) {}

    // During live games, refresh scores + auto-default picks HERE (on the trigger)
    // so real users' getState calls don't have to pay for the ESPN fetch + writes.
    var fetched = maybeAutoFetchScores_(cachedShared);

    // Re-build and cache the state so the next real user gets it instantly -- but
    // only when something could have changed. This used to rebuild every run
    // (~7s x 288 runs/day, a big share of the daily trigger-runtime quota) even
    // overnight when nothing had moved. Writes through the app bust the cache
    // themselves; manual edits do too once installSheetChangeTrigger() has run.
    var builtAt = Number(cache.get(STATE_CACHE_KEY + '_builtAt') || 0);
    var watched = sheetChangeWatched_();
    var fresh = cachedShared && watched && (Date.now() - builtAt) < STATE_MAX_AGE_WATCHED_MS;
    // The 15-min safety-net rebuild refreshes the (long-lived) picks cache too, for
    // raw script writes that bypassed the helpers and never busted it.
    if (fetched) invalidateStateCache();
    else if (cachedShared && watched && !fresh) invalidatePicksBundle_();
    if (fetched || !fresh) {
      var shared = rebuildStateCache_();
      perfNote_('keepWarm', 'rebuilt');
      Logger.log('keepWarm: state cache pre-built, ' + JSON.stringify(shared).length + ' bytes');
    } else {
      perfNote_('keepWarm', 'fresh');
    }
    // Also warm career history (the leaderboard/trophy room/champion rings all use it)
    getCareerHistoryCached();
    // ...and the picks cache, so players' app loads skip the spreadsheet entirely
    try {
      var sharedNow = null; var rawNow = cacheGetChunked_(cache, STATE_CACHE_KEY); if (rawNow) sharedNow = JSON.parse(rawNow);
      getPicksBundle_(sharedNow ? currentWeekOf_(sharedNow) : Number(getSeasonConfig().currentWeek || 1));
    } catch (e) { Logger.log('keepWarm picks warm: ' + e.message); }
    logPerf_('keepWarm', Date.now() - t0, { ok: true });
  } catch(e) {
    Logger.log('keepWarm error: ' + e.message);
    logPerf_('keepWarm', Date.now() - t0, { ok: false, error: e.message });
  }
}

function installKeepWarmTrigger() {
  // Remove any existing keep-warm triggers first
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'keepWarm') ScriptApp.deleteTrigger(t);
  });
  // Create a new one that fires every 4 minutes
  ScriptApp.newTrigger('keepWarm')
    .timeBased()
    .everyMinutes(5)
    .create();
  Logger.log('keepWarm trigger installed — fires every 5 minutes.');
}

// Installable onChange trigger: fires when a PERSON edits the spreadsheet (typing,
// pasting, inserting/deleting rows) -- never for the app's own script writes, which
// already bust the cache in handle(). Run installSheetChangeTrigger() ONCE from the
// Apps Script editor; after that manual fixes show up in the app immediately and
// keepWarm can skip rebuilding the state when nothing changed.
function onSheetChange(e) {
  invalidateCareerHistoryCache(); // also busts the state cache (memberSince comes from it)
  invalidateUpsetHistoryIndex_();
}

function installSheetChangeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'onSheetChange') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onSheetChange').forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet()).onChange().create();
  PropertiesService.getScriptProperties().setProperty('sheetChangeTrigger', '1');
  Logger.log('onSheetChange trigger installed -- manual sheet edits now refresh the app immediately.');
}

function removeKeepWarmTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'keepWarm') ScriptApp.deleteTrigger(t);
  });
  Logger.log('keepWarm trigger removed.');
}

function apiGetAllTimeLeaderboard() {
  // Use shared cache — also warmed by keepWarm trigger
  var careerRows = getCareerHistoryCached();

  var players    = sheetToObjects('Players');
  var pwRows     = [];
  try { pwRows = sheetToObjects('PerfectWeeks'); } catch(e) {}

  // Build playerId -> teamName map for display
  var playerNames = {};
  players.forEach(function(p) { if (p.id) playerNames[String(p.id)] = p.teamName || p.name; });

  // Read trophies from SeasonTrophies sheet (pre-archived — no CareerHistory scan)
  var trophies = {};
  try {
    sheetToObjects(SHEET_NAMES.SEASON_TROPHIES).forEach(function(r) {
      var pid = String(r.playerId||'').trim();
      var key = pid ? ('PID:' + pid) : String(r.teamName||'').trim().toUpperCase();
      if (!key) return;
      if (!trophies[key]) {
        var displayName = pid ? (playerNames[pid] || String(r.teamName||'').trim()) : String(r.teamName||'').trim();
        trophies[key] = { teamName: displayName, playerId: pid, linked: !!pid, gold:[], silver:[], bronze:[] };
      }
      var pos = Number(r.position), yr = Number(r.year);
      if (pos===1) trophies[key].gold.push(yr);
      if (pos===2) trophies[key].silver.push(yr);
      if (pos===3) trophies[key].bronze.push(yr);
    });
  } catch(e) {}

  // Count perfect weeks — key by playerId for linked, teamName for unlinked
  var pwCounts = {};
  pwRows.forEach(function(r) {
    var pid = String(r.playerId||'').trim();
    var key = pid ? ('PID:' + pid) : String(r.teamName||'').trim().toUpperCase();
    if (!key) return;
    if (!pwCounts[key]) pwCounts[key] = [];
    pwCounts[key].push({ week: Number(r.week), year: Number(r.year) });
  });

  // Build career stats per teamName from CareerHistory
  var careerStats = {};
  var byYearStats = {};
  careerRows.forEach(function(r) {
    var yr = Number(r.year); if (!yr || !r.teamName) return;
    if (!byYearStats[yr]) byYearStats[yr] = [];
    byYearStats[yr].push(r);
  });
  careerRows.forEach(function(r) {
    var pid2 = String(r.playerId||'').trim();
    var key = pid2 ? ('PID:' + pid2) : String(r.teamName||'').trim().toUpperCase();
    if (!key) return;
    if (!careerStats[key]) careerStats[key] = { seasons:0, totalPts:0, bestPts:0, podiums:0 };
    careerStats[key].seasons++;
    careerStats[key].totalPts += Number(r.points)||0;
    if ((Number(r.points)||0) > careerStats[key].bestPts) careerStats[key].bestPts = Number(r.points)||0;
  });
  Object.keys(byYearStats).forEach(function(yr) {
    var sorted = byYearStats[yr].slice().sort(function(a,b){ return Number(b.points)-Number(a.points); });
    sorted.slice(0,3).forEach(function(r) {
      var pid2 = String(r.playerId||'').trim();
      var key = pid2 ? ('PID:' + pid2) : String(r.teamName||'').trim().toUpperCase();
      if (careerStats[key]) careerStats[key].podiums++;
    });
  });

  // Build final list
  var list = Object.values(trophies).map(function(t) {
    var key = t.playerId ? ('PID:' + t.playerId) : t.teamName.trim().toUpperCase();
    var pws = pwCounts[key] || [];
    var cs  = careerStats[key] || { seasons:0, totalPts:0, bestPts:0, podiums:0 };
    var avgPts = cs.seasons > 0 ? Math.round(cs.totalPts / cs.seasons * 10) / 10 : 0;
    var podPct = cs.seasons > 0 ? Math.round(cs.podiums / cs.seasons * 1000) / 10 : 0;
    return {
      teamName:    t.teamName,
      playerId:    t.playerId,
      linked:      t.linked,
      gold:        t.gold.sort(),
      silver:      t.silver.sort(),
      bronze:      t.bronze.sort(),
      perfectWeeks: pws,
      total:       t.gold.length + t.silver.length + t.bronze.length,
      seasons:     cs.seasons,
      totalPts:    Math.round(cs.totalPts * 10) / 10,
      avgPts:      avgPts,
      bestPts:     cs.bestPts,
      podiums:     cs.podiums,
      podPct:      podPct
    };
  });

  // Also add players with perfect weeks but no podium finishes
  Object.keys(pwCounts).forEach(function(key) {
    var already = list.some(function(l){
      var lkey = l.playerId ? ('PID:' + l.playerId) : l.teamName.trim().toUpperCase();
      return lkey === key;
    });
    if (!already) {
      // Linked players are keyed 'PID:<id>' -- resolve them by id (looking them up by
      // teamName never matched, so they showed up as "PID:p5" with no stats and were
      // then added a SECOND time by the careerStats loop below).
      var isPid = key.indexOf('PID:') === 0;
      var pwPid = isPid ? key.slice(4) : '';
      var pwRow = isPid
        ? pwRows.find(function(r){ return String(r.playerId||'').trim() === pwPid; })
        : pwRows.find(function(r){ return String(r.teamName||'').trim().toUpperCase() === key; });
      var cs = careerStats[key];
      list.push({
        teamName:    isPid ? (playerNames[pwPid] || (pwRow && pwRow.teamName) || pwPid) : (pwRow ? pwRow.teamName : key),
        playerId:    isPid ? pwPid : (pwRow ? (pwRow.playerId||'') : ''),
        linked:      isPid || !!(pwRow && pwRow.playerId),
        gold: [], silver: [], bronze: [],
        perfectWeeks: pwCounts[key],
        total: 0,
        seasons: cs ? cs.seasons : 0,
        totalPts: cs ? Math.round(cs.totalPts * 10) / 10 : 0,
        avgPts: cs && cs.seasons > 0 ? Math.round(cs.totalPts / cs.seasons * 10) / 10 : 0,
        bestPts: cs ? cs.bestPts : 0,
        podiums: cs ? cs.podiums : 0,
        podPct: cs && cs.seasons > 0 ? Math.round(cs.podiums / cs.seasons * 1000) / 10 : 0
      });
    }
  });

  // Include ALL players who appear in careerStats but have no trophies/PW yet
  Object.keys(careerStats).forEach(function(key) {
    var already = list.some(function(l){
      var lkey = l.playerId ? ('PID:' + l.playerId) : l.teamName.trim().toUpperCase();
      return lkey === key;
    });
    if (!already) {
      var isLinked = key.indexOf('PID:') === 0;
      var pid3 = isLinked ? key.slice(4) : '';
      var tn = isLinked ? (playerNames[pid3] || pid3) : key;
      list.push({
        teamName: tn, playerId: pid3, linked: isLinked,
        gold:[], silver:[], bronze:[],
        perfectWeeks: pwCounts[key] || [],
        total: 0,
        seasons: careerStats[key].seasons,
        totalPts: Math.round(careerStats[key].totalPts * 10) / 10,
        avgPts: careerStats[key].seasons > 0 ? Math.round(careerStats[key].totalPts / careerStats[key].seasons * 10) / 10 : 0,
        bestPts: careerStats[key].bestPts,
        podiums: careerStats[key].podiums,
        podPct: careerStats[key].seasons > 0 ? Math.round(careerStats[key].podiums / careerStats[key].seasons * 1000) / 10 : 0
      });
    }
  });

  list.sort(function(a,b){
    var sa = a.gold.length*4 + a.silver.length*2 + a.bronze.length + (a.perfectWeeks||[]).length;
    var sb = b.gold.length*4 + b.silver.length*2 + b.bronze.length + (b.perfectWeeks||[]).length;
    return sb - sa || b.gold.length - a.gold.length;
  });

  return { ok: true, leaderboard: list };
}

function apiGetCareerHistory() {
  var rows = getCareerHistoryCached();
  var history = rows.filter(function(r){ return r.year; }).map(function(r){
    return {
      playerId: String(r.playerId||'').trim(),
      name:     String(r.name||'').trim(),
      teamName: String(r.teamName||'').trim(),
      year:     Number(r.year),
      points:   Number(r.points),
      matched:  r.matched === 'YES' || r.matched === true
    };
  });
  return { ok: true, history: history };
}

function apiUpdateProfile(payload) {
  var playerId = payload.playerId;
  if (!playerId) return { ok: false, error: 'Missing playerId.' };

  var updates = {};
  // only allow safe fields — never pin, isAdmin, active via this endpoint
  if (payload.venmo  !== undefined) updates.venmo  = String(payload.venmo  || '').trim();
  if (payload.paypal !== undefined) updates.paypal = String(payload.paypal || '').trim();
  if (payload.paymentPref !== undefined) updates.paymentPref = String(payload.paymentPref || '').trim();
  if (payload.scoreNotif !== undefined) updates.scoreNotif = String(payload.scoreNotif || 'each').trim();
  if (payload.chatNotif  !== undefined) updates.chatNotif  = String(payload.chatNotif  || 'on').trim();
  if (payload.avatar !== undefined) {
    // avatar is base64 image — cap at 200KB to keep sheet manageable
    var av = String(payload.avatar || '');
    if (av.length > 200000) return { ok: false, error: 'Avatar image is too large. Please use a smaller image.' };
    updates.avatar = av;
  }
  if (payload.teamName !== undefined) {
    var tn = String(payload.teamName || '').trim().toUpperCase();
    if (!tn) return { ok: false, error: 'Team name cannot be empty.' };
    updates.teamName = tn;
  }

  if (Object.keys(updates).length === 0) return { ok: false, error: 'No fields to update.' };

  var found = updateRowByMatch(SHEET_NAMES.PLAYERS, function(r) { return r.id === playerId; }, updates);
  if (!found) return { ok: false, error: 'Player not found.' };
  invalidateStateCache();
  return { ok: true, updates: updates };
}

function apiChangePin(payload) {
  var playerId   = payload.playerId;
  var currentPin = String(payload.currentPin || '').trim();
  var newPin     = String(payload.newPin || '').trim();

  if (!playerId || !currentPin || !newPin) {
    return { ok: false, error: 'Missing required fields.' };
  }
  var pinErr = pinProblem_(newPin);
  if (pinErr) return { ok: false, error: pinErr };

  var players = sheetToObjects(SHEET_NAMES.PLAYERS);
  var player  = players.find(function(p) { return p.id === playerId; });
  if (!player) return { ok: false, error: 'Player not found.' };

  if (String(player.pin).trim() !== currentPin) {
    return { ok: false, error: 'Current PIN is incorrect.' };
  }

  updateRowByMatch(SHEET_NAMES.PLAYERS, function(r) { return r.id === playerId; }, { pin: newPin });
  invalidateStateCache();
  return { ok: true };
}

// ── Automated Pick Reminders ───────────────────────────────────────────────────
// Checks the CURRENT week's board (whichever week Season config points to) and
// finds every active player who hasn't finished submitting picks — missing any
// of the straight picks, or missing their Upset Special. Notifies ONLY those
// players. Two variants, different urgency:
//   sendPickReminders()      — the first, standard reminder (9 AM)
//   sendFinalPickReminder()  — the second, warns that missing picks get
//                              defaulted to the favorite with no Upset Special
//                              bonus available (10:30 AM)
// Both are thin wrappers around the shared logic below.
function sendPickReminders() { sendPickReminders_(false); }
function sendFinalPickReminder() { sendPickReminders_(true); }

function sendPickReminders_(isFinal) {
  var week = Number(getSeasonConfig().currentWeek || 0);
  var boardGames = sheetToObjects(SHEET_NAMES.GAMES).filter(function(g) {
    return Number(g.week) === week && g.source !== 'external' && (g.locked === true || g.locked === 'TRUE');
  });
  if (boardGames.length === 0) {
    Logger.log('No posted board found for week ' + week + ' — nothing to remind about.');
    return;
  }
  var expectedStraightCount = boardGames.length;

  var players = sheetToObjects(SHEET_NAMES.PLAYERS).filter(function(p) { return p.active; });
  var weekPicks = sheetToObjects(SHEET_NAMES.PICKS).filter(function(p) { return Number(p.week) === week; });

  // Players can save a partial board, so each reminder says what THAT player still needs.
  var todo = {};
  var nonPickers = players.filter(function(player) {
    var myPicks = weekPicks.filter(function(p) { return p.playerId === player.id; });
    var straightCount = myPicks.filter(function(p) { return !(p.isUpset === true || p.isUpset === 'TRUE'); }).length;
    var hasUpset = myPicks.some(function(p) { return p.isUpset === true || p.isUpset === 'TRUE'; });
    todo[player.id] = { missing: Math.max(expectedStraightCount - straightCount, 0), hasUpset: hasUpset, none: myPicks.length === 0 };
    return straightCount < expectedStraightCount || !hasUpset;
  });
  // e.g. "3 games and your Upset Special" / "your Upset Special" / "1 game"
  var stillToPick = function(t) {
    var parts = [];
    if (t.missing > 0) parts.push(t.missing + (t.missing === 1 ? ' game' : ' games'));
    if (!t.hasUpset) parts.push('your Upset Special');
    return parts.join(' and ');
  };

  if (nonPickers.length === 0) {
    Logger.log('Everyone has submitted picks for week ' + week + ' — no ' + (isFinal ? 'final ' : '') + 'reminder needed.');
    return;
  }

  Logger.log((isFinal ? 'FINAL reminder' : 'Reminder') + ' — ' + nonPickers.length + ' player(s) for week ' + week + ': ' + nonPickers.map(function(p) { return p.teamName; }).join(', '));

  // Push notification
  var pushTitle = isFinal ? '🚨 Final warning — picks close soon!' : '⏰ Picks close soon!';
  var pushBodyFor = function(t) {
    if (t.none) {
      return isFinal
        ? "Still no picks for Week " + week + '. Miss the deadline and you get the favorite in every game with zero shot at the Upset Special bonus.'
        : "You haven't made your Week " + week + ' picks yet — get them in before kickoff.';
    }
    return 'Week ' + week + ': you still need to pick ' + stillToPick(t) + '.' +
      (isFinal ? (t.hasUpset ? ' Unpicked games default to the favorite.' : ' No Upset Special = no upset bonus this week.') : ' Finish before kickoff.');
  };
  var reminderMsgs = [];
  nonPickers.forEach(function(p) {
    var pushBody = pushBodyFor(todo[p.id]);
    if (p.fcmToken && String(p.fcmToken).trim() !== '') {
      String(p.fcmToken).split(',').map(function(t) { return t.trim(); }).filter(Boolean).forEach(function(token) {
        reminderMsgs.push({ token: token, title: pushTitle, body: pushBody, data: { type: 'pick_reminder' } });
      });
    }
  });
  sendFcmBatch_(reminderMsgs);

  var recipients = nonPickers.filter(function(p) { return p.email && String(p.email).indexOf('@') > 0; });
  var quota = MailApp.getRemainingDailyQuota();
  if (quota < recipients.length) {
    Logger.log('Email quota too low (' + quota + ' remaining, ' + recipients.length + ' needed) — push notifications still went out, but skipping email this run.');
    return;
  }

  if (!isFinal) {
    // First reminder (3 hours before kickoff, same day) — built inline, NOT
    // pulled from email2c_picks_reminder.html. That template says "one day
    // left" / "kicks off tomorrow", which is correct for a manual day-before
    // send but wrong here, since this automated reminder fires the SAME DAY,
    // a few hours before kickoff. Keeping the two separate avoids resurfacing
    // this mismatch — email2c remains available for you to send manually
    // whenever a true day-before heads-up makes sense.
    var title = 'Kickoff is today';
    var body =
      '<p style="margin-bottom:16px;">The first game of Week ' + week + ' kicks off in a few hours, and you haven\'t finished your picks.</p>' +
      '<div style="border-left:4px solid #F2B632;background:#fffbf2;border-radius:0 8px 8px 0;padding:14px 16px;margin:18px 0;font-size:14px;color:#3a2a00;line-height:1.6;">' +
      '<strong style="color:#8c6a2a;text-transform:uppercase;font-size:12px;letter-spacing:0.08em;display:block;margin-bottom:6px;">⏱ Deadlines don\'t move</strong>' +
      "Each straight pick locks 5 minutes before that specific game's kickoff. Your <strong>Upset Special</strong> pick locks 5 minutes before the <em>first</em> game — so don\'t wait too long." +
      '</div>' +
      '<p style="margin-bottom:16px;">It only takes a couple minutes. Get them in now.</p>';
    var sent = 0;
    recipients.forEach(function(p) {
      var t = todo[p.id];
      var html = buildEmailHtml(title, t.none ? "You haven't made your Week " + week + ' picks yet.' : 'You still need to pick ' + stillToPick(t) + '.', body);
      try {
        MailApp.sendEmail({ to: p.email, subject: '⏰ Kickoff today — Week ' + week + ' picks still open', htmlBody: html, name: 'Upset Special League' });
        sent++;
      } catch (e) { Logger.log('Reminder email failed for ' + p.teamName + ': ' + e.message); }
    });
    logEmailSend_('⏰ Kickoff today — Week ' + week + ' picks still open', sent, 'reminder-auto', 'system');
    Logger.log('Reminder email sent to ' + sent + ' player(s).');
  } else {
    // Final reminder — built inline (not a Drive template) since the "default to
    // favorite, no Upset Special" warning is specific to this last-chance email
    // and doesn't need to live as a separate reusable file.
    var title = 'Last chance for Week ' + week;
    var body =
      '<p style="margin-bottom:16px;">This is the final reminder for Week ' + week + ' — the board locks soon and your picks aren\'t complete.</p>' +
      '<div style="border-left:4px solid #FF4D5E;background:#fff5f5;border-radius:0 8px 8px 0;padding:14px 16px;margin:18px 0;font-size:14px;color:#5a0010;line-height:1.6;">' +
      '<strong style="color:#3a0008;display:block;margin-bottom:4px;">⚠️ What happens if you miss the deadline</strong>' +
      "Any game you haven't picked gets defaulted to the favorite once it locks — you'll still get credit for correct favorites, but you get <strong>zero shot at the Upset Special bonus</strong> that week, since there's no default for that pick." +
      '</div>' +
      '<p style="margin-bottom:16px;">It takes about two minutes. Don\'t leave points on the table.</p>';
    var sent = 0;
    recipients.forEach(function(p) {
      var t = todo[p.id];
      var html = buildEmailHtml(title, t.none ? "You haven't made your picks yet." : 'You still need to pick ' + stillToPick(t) + '.', body);
      try {
        MailApp.sendEmail({ to: p.email, subject: '🚨 Final call — Week ' + week + ' picks close soon', htmlBody: html, name: 'Upset Special League' });
        sent++;
      } catch (e) { Logger.log('Final reminder email failed for ' + p.teamName + ': ' + e.message); }
    });
    logEmailSend_('🚨 Final call — Week ' + week + ' picks close soon', sent, 'reminder-final-auto', 'system');
    Logger.log('Final reminder email sent to ' + sent + ' player(s).');
  }
}

// Schedules this week's two pick reminders as ONE-TIME triggers, timed relative
// to the week's ACTUAL earliest kickoff — 3 hours before for the standard
// reminder, 90 minutes before for the final "default to favorite" warning.
// Called automatically from apiAdminPostWeek() every time a board is posted, so
// this runs hands-free for every future week without any manual step. Clears
// any previously-scheduled reminder triggers first, so re-posting a week (or
// posting a new one) never stacks duplicates.
function scheduleWeeklyPickReminders(week) {
  var boardGames = sheetToObjects(SHEET_NAMES.GAMES).filter(function(g) {
    return Number(g.week) === week && g.source !== 'external' && (g.locked === true || g.locked === 'TRUE') && g.kickoff;
  });
  if (boardGames.length === 0) {
    Logger.log('No posted games with kickoff times found for week ' + week + ' — nothing to schedule.');
    return;
  }

  var kickoffTimes = boardGames.map(function(g) { return new Date(g.kickoff).getTime(); }).filter(function(t) { return !isNaN(t); });
  if (kickoffTimes.length === 0) {
    Logger.log('Could not parse any kickoff times for week ' + week + ' — nothing to schedule.');
    return;
  }
  var firstKickoff = new Date(Math.min.apply(null, kickoffTimes));
  var lastKickoff  = new Date(Math.max.apply(null, kickoffTimes));

  ['sendPickReminders', 'sendFinalPickReminder', 'applyWeeklyDefaults'].forEach(function(fn) {
    ScriptApp.getProjectTriggers().forEach(function(t) {
      if (t.getHandlerFunction() === fn) ScriptApp.deleteTrigger(t);
    });
  });

  var now = new Date();
  var threeHoursBefore = new Date(firstKickoff.getTime() - 3 * 60 * 60 * 1000);
  var ninetyMinBefore  = new Date(firstKickoff.getTime() - 90 * 60 * 1000);
  // 5 minutes after the LAST game kicks off — by then every game has started,
  // so filling in favorite defaults at this single point never takes away
  // anyone's chance to make a real pick on a game that hadn't started yet.
  var defaultsTime = new Date(lastKickoff.getTime() + 5 * 60 * 1000);

  if (threeHoursBefore > now) {
    ScriptApp.newTrigger('sendPickReminders').timeBased().at(threeHoursBefore).create();
  } else {
    Logger.log('3-hours-before reminder for week ' + week + ' would already be in the past — skipped.');
  }
  if (ninetyMinBefore > now) {
    ScriptApp.newTrigger('sendFinalPickReminder').timeBased().at(ninetyMinBefore).create();
  } else {
    Logger.log('90-minutes-before reminder for week ' + week + ' would already be in the past — skipped.');
  }
  if (defaultsTime > now) {
    ScriptApp.newTrigger('applyWeeklyDefaults').timeBased().at(defaultsTime).create();
  } else {
    Logger.log('Auto-defaults time for week ' + week + ' would already be in the past — skipped. Use the Admin panel button to apply defaults manually this week.');
  }

  Logger.log('Week ' + week + ' first kickoff: ' + firstKickoff.toString() + ', last kickoff: ' + lastKickoff.toString() + '. Reminders scheduled for ' + threeHoursBefore.toString() + ' and ' + ninetyMinBefore.toString() + '. Auto-defaults scheduled for ' + defaultsTime.toString() + '.');
}

// Runs automatically once the week's last game has kicked off (scheduled
// alongside the pick reminders above). Fills in the favorite for anyone still
// missing a straight pick, without depending on someone happening to open the
// app while games are live — which is what made the old automatic path
// unreliable. Safe to also run manually via the Admin panel button any time.
function applyWeeklyDefaults() {
  var week = Number(getSeasonConfig().currentWeek || 0);
  var count = applyNoPickDefaults_(week);
  Logger.log('Auto-applied favorite defaults for week ' + week + ': ' + count + ' pick(s) filled in.');
}

// Run this ONCE, manually, for the CURRENT week only — needed for Week 0, since
// it was already posted before this automated system existed. Every week posted
// through the admin panel from now on schedules its own reminders automatically
// (via apiAdminPostWeek), so you will not need to run this again after Week 0.
function runScheduleRemindersForCurrentWeek() {
  var week = Number(getSeasonConfig().currentWeek || 0);
  scheduleWeeklyPickReminders(week);
}

function apiAdminClearWeek(payload) {
  requireAdmin(payload);
  const week = Number(payload.week);
  if (!week && week !== 0) return { ok: false, error: 'No week specified.' };

  // remove all games for this week
  deleteRowsByMatchFast_(SHEET_NAMES.GAMES, r => Number(r.week) === week);

  // remove all picks for this week
  deleteRowsByMatchFast_(SHEET_NAMES.PICKS, r => Number(r.week) === week);

  // remove line snapshot rows for this week
  deleteRowsByMatchFast_(SHEET_NAMES.LINE_SNAPSHOT, r => Number(r.week) === week);

  // remove rotation entry for this week
  deleteRowsByMatchFast_(SHEET_NAMES.ROTATION, r => Number(r.week) === week);

  invalidateSheetCache(SHEET_NAMES.GAMES);
  invalidateSheetCache(SHEET_NAMES.PICKS);
  invalidateSheetCache(SHEET_NAMES.LINE_SNAPSHOT);
  invalidateSheetCache(SHEET_NAMES.ROTATION);
  invalidateStateCache();
  return { ok: true, message: `Week ${week} data cleared successfully.` };
}

function isGameLockedServer(game, now) {
  // a game is locked the moment ANY of these are true: it's marked final, it's within 5 minutes of kickoff,
  // or kickoff has already passed. Missing kickoff data never unlocks a final game.
  if (game.isFinal === true || game.isFinal === 'TRUE') return true;
  if (!game.kickoff) return false;
  const lockTime = new Date(new Date(game.kickoff).getTime() - 5 * 60 * 1000);
  return now >= lockTime;
}

// ---------- REGULAR SEASON: PLAYER PICKS ----------

function apiSubmitPicks(payload) {
  const week = Number(payload.week);
  const playerId = payload.playerId;
  const picks = payload.picks || []; // [{gameId, pickedTeam, isUpset, espnEventId?, awayTeam?, homeTeam?, favorite?, spread?, kickoff?}]

  // Serialize submissions for this exact player+week. Without this, two near-simultaneous
  // requests (double-tap, a retry after a slow response, two tabs open) can each read the
  // same "before" state, then both delete-then-insert -- leaving duplicate rows (e.g. two
  // Upset Special picks) instead of one clean replacement. A 15s wait is far more than a
  // single submission ever needs; if it times out, something else is genuinely wrong and
  // failing loudly is correct.
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (e) {
    return { ok: false, error: 'Another submission for this player is still processing -- please try again in a moment.' };
  }
  try {
    // A repeat of a save that already ran (same player + requestId: the app or the Cloudflare
    // front door resending after Google lost the answer or sent an error page) gets the
    // original answer back and saves NOTHING. Checked inside the lock, so a repeat that
    // arrives while the original is still running waits for it and then finds its answer.
    var reqKey = submitRequestKey_(playerId, payload.requestId);
    var cache = reqKey ? CacheService.getScriptCache() : null;
    if (reqKey) {
      var prev = null;
      try { prev = cache.get(reqKey); } catch (e) {}
      if (prev) { perfNote_('repeatSave', 'answered from first save'); return JSON.parse(prev); }
    }
    var result = apiSubmitPicks_(payload, week, playerId, picks);
    if (reqKey && result) { try { cache.put(reqKey, JSON.stringify(result), 21600); } catch (e) {} }
    return result;
  } finally {
    releaseLock_(lock);
  }
}

function submitRequestKey_(playerId, requestId) {
  requestId = String(requestId || '');
  if (!requestId || requestId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(requestId)) return null;
  return 'submitReq_' + String(playerId || '') + '_' + requestId;
}

function apiSubmitPicks_(payload, week, playerId, picks) {

  const weekGames = sheetToObjects(SHEET_NAMES.GAMES).filter(g => Number(g.week) === week);
  if (weekGames.length === 0 || weekGames.some(g => g.locked !== true && g.locked !== 'TRUE')) {
    return { ok: false, error: 'This week is not posted yet.' };
  }
  const now = new Date();
  const existingPicksForPlayer = sheetToObjects(SHEET_NAMES.PICKS).filter(ep => Number(ep.week) === week && ep.playerId === playerId);

  // enforce per-game lock for the 10 straight picks: locked if within 5 min of kickoff, already started, or final --
  // applies equally to a first submission and to changing an existing pick. The only picks exempt from this check
  // are ones whose value is IDENTICAL to what's already on file (a no-op resubmission of an unchanged pick),
  // so re-saving the same slate after one game locks doesn't block you from updating the others.
  const straightPicks = picks.filter(p => !p.isUpset);
  const boardGames = sheetToObjects(SHEET_NAMES.GAMES).filter(g =>
    Number(g.week) === week && g.source !== 'external' &&
    (g.locked === true || g.locked === 'TRUE')
  );
  // Partial saves are allowed: a player can save some games now and finish later. Games
  // left out keep whatever is already saved for them (see the merge at the end); anything
  // still missing at kickoff is defaulted to the favorite as before.
  const boardIds = new Set(boardGames.map(g => g.gameId));
  const seenIds = new Set();
  for (const p of straightPicks) {
    if (!boardIds.has(p.gameId)) return { ok: false, error: 'One of those games isn\'t on this week\'s board -- refresh the app and try again.' };
    if (seenIds.has(p.gameId)) return { ok: false, error: 'The same game was picked twice -- refresh the app and try again.' };
    seenIds.add(p.gameId);
  }
  const upsetPicks = picks.filter(p => p.isUpset);
  if (upsetPicks.length > 1) return { ok: false, error: 'Only one Upset Special pick is allowed.' };
  if (straightPicks.length === 0 && upsetPicks.length === 0) return { ok: false, error: 'Pick at least one game before saving.' };
  for (const p of straightPicks) {
    const g = weekGames.find(wg => wg.gameId === p.gameId);
    if (!g) continue;
    const existing = existingPicksForPlayer.find(ep => ep.gameId === p.gameId);
    const isUnchanged = existing && existing.pickedTeam === p.pickedTeam && (existing.isUpset === true || existing.isUpset === 'TRUE') === false;
    if (isGameLockedServer(g, now) && !isUnchanged) {
      return { ok: false, error: `${g.awayTeam} @ ${g.homeTeam} has already locked (within 5 minutes of kickoff, started, or final) -- that pick can no longer be changed.` };
    }
  }

  let upsetGameId = null;
  let createdGame = null;
  if (upsetPicks.length === 1) {
    const res = resolveUpsetPick_(upsetPicks[0], week, now, existingPicksForPlayer);
    if (res.ok === false) return res;
    upsetGameId = res.upsetGameId;
    createdGame = res.createdGame;
  }

  // Replace the player's picks for the week: grouped row deletes + ONE batched append
  // (was 11 single-row deletes + 11 appendObject calls = ~35 spreadsheet calls, all
  // while holding the league-wide script lock that every other submitter waits on).
  // Saved picks for games not in this submission (and the saved Upset Special, if none
  // was sent) are carried over unchanged, so a partial save never erases earlier picks.
  const isUpsetRow = p => p.isUpset === true || p.isUpset === 'TRUE';
  const carried = existingPicksForPlayer
    .filter(ep => isUpsetRow(ep) ? !upsetGameId : (boardIds.has(ep.gameId) && !seenIds.has(ep.gameId)))
    .map(ep => ({ week, playerId, gameId: ep.gameId, pickedTeam: ep.pickedTeam, isUpset: isUpsetRow(ep), isAutoDefault: ep.isAutoDefault === true || ep.isAutoDefault === 'TRUE', submittedAt: ep.submittedAt }));
  deleteRowsByMatch(SHEET_NAMES.PICKS, p => Number(p.week) === week && p.playerId === playerId);
  const submittedAt = new Date().toISOString();
  const newRows = carried.concat(straightPicks.map(p => ({ week, playerId, gameId: p.gameId, pickedTeam: p.pickedTeam, isUpset: false, isAutoDefault: false, submittedAt: submittedAt })));
  if (upsetGameId) newRows.push({ week, playerId, gameId: upsetGameId, pickedTeam: upsetPicks[0].pickedTeam, isUpset: true, isAutoDefault: false, submittedAt: submittedAt });
  appendObjects_(SHEET_NAMES.PICKS, newRows);
  // Picks are never part of the cached state, so only a newly-created external game needs a cache bust
  if (createdGame) invalidateStateCache();
  const missing = boardGames.filter(g => !newRows.some(r => r.gameId === g.gameId && !r.isUpset)).length;
  return { ok: true, missing: missing, hasUpset: newRows.some(r => r.isUpset) };
}

// Validates an Upset Special pick and finds/creates its game row. Returns
// { upsetGameId, createdGame } or { ok: false, error }.
function resolveUpsetPick_(upsetPick, week, now, existingPicksForPlayer) {
  // upset pick may reference a game NOT in this week's 10 -- if it carries its own espn fields, create/find a Games row for it
  let upsetGameId = upsetPick.gameId;
  let createdGame = null;
  if (upsetPick.espnEventId || upsetPick.awayTeam) {
    const allGames = sheetToObjects(SHEET_NAMES.GAMES);
    let existingExternal = upsetPick.espnEventId
      ? allGames.find(g => String(g.espnEventId) === String(upsetPick.espnEventId))
      : null;
    if (!existingExternal) {
      // always use the Monday snapshot line for scoring -- never the player's submitted spread
      // (which came from search results that may have been fetched at any point during the week)
      const snapshotRow = upsetPick.espnEventId
        ? sheetToObjects(SHEET_NAMES.LINE_SNAPSHOT).find(r => String(r.espnEventId) === String(upsetPick.espnEventId) && Number(r.week) === week)
        : null;
      // Only games with a frozen line can be an Upset Special (the search only lists
      // those). Without this, a hand-crafted request could supply its own spread,
      // which would then be scored as the upset's point value.
      if (!snapshotRow) {
        return { ok: false, error: 'That game doesn\'t have a frozen line yet, so it can\'t be your Upset Special. Pick a game from the search list.' };
      }

      const frozenFavorite = snapshotRow ? snapshotRow.favorite : upsetPick.favorite;
      const frozenSpread   = snapshotRow ? snapshotRow.spread   : upsetPick.spread;
      const frozenKickoff  = snapshotRow ? snapshotRow.kickoff  : (upsetPick.kickoff || '');

      const newGame = {
        week, gameId: genId('g'), espnEventId: upsetPick.espnEventId || '',
        awayTeam: upsetPick.awayTeam, homeTeam: upsetPick.homeTeam,
        favorite: frozenFavorite, spread: frozenSpread,
        source: 'external', // marks this as an upset-special game outside the board's 10
        kickoff: frozenKickoff, locked: true, finalAwayScore: '', finalHomeScore: '',
        isFinal: false, postedAt: new Date().toISOString(),
        homeLogo: upsetPick.homeLogo || '', awayLogo: upsetPick.awayLogo || ''
      };
      // re-check the game isn't already started/final against live ESPN before accepting
      if (upsetPick.espnEventId) {
        const freshEvents = fetchEspnScoreboard();
        const freshEv = freshEvents.find(e => String(e.id) === String(upsetPick.espnEventId));
        if (freshEv) {
          const freshComp = freshEv.competitions[0];
          const freshIsFinal = freshComp.status && freshComp.status.type && freshComp.status.type.completed;
          const freshKickoff = freshEv.date || freshComp.date;
          if (freshIsFinal || (freshKickoff && now > new Date(new Date(freshKickoff).getTime() - 5 * 60 * 1000))) {
            return { ok: false, error: 'That game has already started, finished, or is within 5 minutes of kickoff -- pick a different underdog.' };
          }
        }
      }
      appendObject(SHEET_NAMES.GAMES, newGame);
      upsetGameId = newGame.gameId;
      createdGame = newGame;
    } else {
      upsetGameId = existingExternal.gameId;
    }
  }
  // Use the just-created game directly: the request-scoped Games cache doesn't contain
  // it yet, so the lookup below used to return undefined for brand-new external games --
  // silently skipping BOTH the "must be the underdog" and the lock checks.
  const upsetGame = createdGame || sheetToObjects(SHEET_NAMES.GAMES).find(g => g.gameId === upsetGameId);
  if (upsetGame && String(upsetGame.favorite).trim() !== '' && upsetPick.pickedTeam === upsetGame.favorite) {
    return { ok: false, error: 'Your Upset Special pick must be the underdog, not the favorite.' };
  }

  // Find the player's actual previous Upset Special pick, regardless of which
  // game it was on -- a player changing their upset to a different game has no
  // existing pick row for the NEW gameId, so matching only on upsetGameId (as
  // the code used to) would miss their real previous selection entirely.
  const previousUpsetPick = existingPicksForPlayer.find(ep => ep.isUpset === true || ep.isUpset === 'TRUE');
  const upsetUnchanged = previousUpsetPick && previousUpsetPick.gameId === upsetGameId && previousUpsetPick.pickedTeam === upsetPick.pickedTeam;

  if (upsetGame && isGameLockedServer(upsetGame, now) && !upsetUnchanged) {
    return { ok: false, error: 'That game has already locked (within 5 minutes of kickoff, started, or final) -- pick a different underdog.' };
  }

  // If the player is switching their Upset Special to a DIFFERENT game than
  // their existing pick, their previous pick's game must not have already
  // started or finished -- otherwise they could watch their original upset
  // miss and then freely grab a different, still-upcoming underdog, which
  // defeats the whole point of committing to a pick before the outcome is
  // known. If their previous game hasn't started yet, switching is fine --
  // they're not gaining any information advantage by doing so.
  if (previousUpsetPick && previousUpsetPick.gameId !== upsetGameId) {
    const previousGame = sheetToObjects(SHEET_NAMES.GAMES).find(g => g.gameId === previousUpsetPick.gameId);
    if (previousGame && isGameLockedServer(previousGame, now)) {
      return { ok: false, error: 'Your current Upset Special pick (' + previousGame.awayTeam + ' @ ' + previousGame.homeTeam + ') has already started or finished -- it can no longer be changed to a different game.' };
    }
  }
  return { upsetGameId: upsetGameId, createdGame: createdGame };
}

// ---------- REGULAR SEASON: RESULTS ----------



// Clear SeasonTrophies sheet so it can be cleanly re-archived
// Use this if trophy positions were archived with bad data
function apiAdminClearSeasonTrophies(payload) {
  requireAdmin(payload);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAMES.SEASON_TROPHIES);
  if (sheet) ss.deleteSheet(sheet);
  // Recreate fresh with headers
  var newSheet = ss.insertSheet(SHEET_NAMES.SEASON_TROPHIES);
  newSheet.appendRow(HEADERS.SeasonTrophies);
  return { ok: true, message: 'SeasonTrophies cleared — run Archive Season Trophies to rebuild' };
}

// Archive season trophy positions (1st/2nd/3rd) for all players into SeasonTrophies sheet.
// Reads from CareerHistory (historical) + current-season computed standings.
// Idempotent — skips year/player combos already archived. Run once to backfill, then
// call at season end. Historical years (< current year) are frozen and safe to archive.
function apiAdminArchiveSeasonTrophies(payload) {
  requireAdmin(payload);
  var targetYear = payload.year ? Number(payload.year) : null; // null = all years

  // Load existing archived trophies to avoid duplicates
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var trophySheet = ss.getSheetByName(SHEET_NAMES.SEASON_TROPHIES);
  if (!trophySheet) {
    trophySheet = ss.insertSheet(SHEET_NAMES.SEASON_TROPHIES);
    trophySheet.appendRow(HEADERS.SeasonTrophies);
  }
  var existing = sheetToObjects(SHEET_NAMES.SEASON_TROPHIES);
  var existingKeys = {};
  existing.forEach(function(r) { existingKeys[r.playerId + '_' + r.year] = true; });

  var norm = function(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g,'').trim(); };
  // Read CareerHistory directly — bypass cache which may be truncated at 90KB
  // and might be missing unlinked rows at the top of the standings
  var allHistory = sheetToObjects('CareerHistory');

  // Get all unique years in CareerHistory
  var yearsSeen = {};
  allHistory.forEach(function(r) { if (r.year) yearsSeen[Number(r.year)] = true; });
  var years = Object.keys(yearsSeen).map(Number).filter(function(yr) {
    return targetYear === null || yr === targetYear;
  });

  var players = sheetToObjects(SHEET_NAMES.PLAYERS);
  var archived = 0;

  years.forEach(function(yr) {
    // Get all rows for this year, deduplicated by playerId first then teamName
    // Step 1: group by playerId (for linked players — merge all their team name rows)
    // Step 2: group remaining unlinked rows by norm(teamName)
    // This prevents a player appearing twice (once linked, once unlinked)
    var byPlayerId = {};
    var byTeamName = {};
    allHistory.filter(function(r) { return Number(r.year) === yr; }).forEach(function(r) {
      if (r.playerId) {
        // Linked row — keep highest points for this player
        if (!byPlayerId[r.playerId] || Number(r.points) > Number(byPlayerId[r.playerId].points)) {
          byPlayerId[r.playerId] = r;
        }
      } else {
        // Unlinked row — group by norm(teamName), keep highest points
        var n = norm(r.teamName);
        if (!byTeamName[n] || Number(r.points) > Number(byTeamName[n].points)) {
          byTeamName[n] = r;
        }
      }
    });
    // Remove unlinked rows whose teamName matches a linked player's teamName
    var linkedNorms = Object.values(byPlayerId).map(function(r) { return norm(r.teamName); });
    Object.keys(byTeamName).forEach(function(n) {
      if (linkedNorms.indexOf(n) >= 0) delete byTeamName[n];
    });
    var allRows = Object.values(byPlayerId).concat(Object.values(byTeamName));
    var sorted = allRows.sort(function(a, b) {
      return Number(b.points) - Number(a.points);
    });
    // Debug log — shows exactly who is in the top 5 for each year
    Logger.log('Year ' + yr + ' — top 5: ' + sorted.slice(0,5).map(function(r){ return (r.teamName||'?') + '(' + r.points + ')'; }).join(', '));

    // Walk ALL sorted rows in true rank order (position = index + 1 across everyone)
    // Write a trophy only when the row is in top 3 AND we can identify the player
    // Unidentifiable rows (old team names with no playerId match) still consume their position
    sorted.forEach(function(row, idx) {
      var position = idx + 1;
      if (position > 3) return; // only top 3 earn trophies
      // Resolve playerId — use linked id or look up by current teamName
      var playerId = row.playerId || '';
      if (!playerId) {
        var matched = players.find(function(p) { return norm(p.teamName) === norm(row.teamName); });
        if (matched) playerId = matched.id;
      }
      // Can't identify — position is consumed but no record written
      if (!playerId) return; // can't link — skip

      var key = playerId + '_' + yr;
      if (existingKeys[key]) return; // already archived

      appendObject(SHEET_NAMES.SEASON_TROPHIES, {
        playerId: playerId,
        teamName: row.teamName,
        year: yr,
        position: position,
        points: Number(row.points),
        archivedAt: new Date().toISOString()
      });
      existingKeys[key] = true;
      archived++;
    });
  });

  // Bust trophy caches so next load reflects new data
  invalidateStateCache();

  return { ok: true, archived: archived, yearsScanned: years.length };
}

// Archive perfect weeks for all players into the PerfectWeeks sheet.
// Run this once manually to backfill history, then it fires automatically
// after each week's results are fetched. Idempotent — skips weeks already archived.
function apiAdminArchivePerfectWeeks(payload) {
  requireAdmin(payload);
  return archivePerfectWeeks_(payload.week ? Number(payload.week) : null);
}

// The ONE place perfect weeks are decided and recorded (against the spread, same
// rule as the standings). Called by the admin button, by Fetch Results, and by the
// Notifications.gs week-final job. Idempotent -- skips anything already archived.
function archivePerfectWeeks_(targetWeek) { // null = all weeks
  targetWeek = targetWeek ? Number(targetWeek) : null;
  var season = getSeasonConfig();
  var currentYear = Number(season.year || new Date().getFullYear());

  var games = sheetToObjects(SHEET_NAMES.GAMES).filter(function(g) {
    return (g.isFinal === true || g.isFinal === 'TRUE') && g.source !== 'external';
  });
  var allPicks = sheetToObjects(SHEET_NAMES.PICKS);
  var players  = sheetToObjects(SHEET_NAMES.PLAYERS).filter(function(p) { return p.active; });

  // Load existing PerfectWeeks to avoid duplicates
  var existing = sheetToObjects(SHEET_NAMES.PERFECT_WEEKS);
  var existingKeys = {};
  existing.forEach(function(r) { existingKeys[r.playerId + '_' + r.year + '_' + r.week] = true; });

  // Get unique completed weeks
  var weeksSeen = {};
  games.forEach(function(g) { weeksSeen[Number(g.week)] = true; });
  var completedWeeks = Object.keys(weeksSeen).map(Number).filter(function(wk) {
    return wk > 0 && (targetWeek === null || wk === targetWeek); // Week 0 is practice — never awards 10/10
  });

  // Index straight picks by "playerId|week" once (was a full scan of every pick
  // for every player x week -- millions of iterations late in the season)
  var straightByPlayerWeek = {};
  allPicks.forEach(function(pk) {
    if (pk.isUpset === true || pk.isUpset === 'TRUE') return;
    var k = pk.playerId + '|' + Number(pk.week);
    (straightByPlayerWeek[k] = straightByPlayerWeek[k] || []).push(pk);
  });

  var archived = 0;
  var newRows = [];
  completedWeeks.forEach(function(wk) {
    var wkGames = games.filter(function(g) { return Number(g.week) === wk; });
    if (wkGames.length === 0) return;

    players.forEach(function(player) {
      var key = player.id + '_' + currentYear + '_' + wk;
      if (existingKeys[key]) return; // already archived

      var wkPicks = straightByPlayerWeek[player.id + '|' + wk] || [];
      if (wkPicks.length !== wkGames.length) return; // missing picks

      var allCorrect = wkGames.every(function(g) {
        var pk = wkPicks.find(function(p) { return p.gameId === g.gameId; });
        return pk && String(pk.pickedTeam) === computeCoveringTeam_(g);
      });

      if (allCorrect) {
        newRows.push({
          playerId: player.id,
          teamName: player.teamName,
          week: wk,
          year: currentYear,
          totalGames: wkGames.length
        });
        existingKeys[key] = true;
        archived++;
      }
    });
  });
  appendObjects_(SHEET_NAMES.PERFECT_WEEKS, newRows);

  // Bust trophy caches for affected players so next load is fresh
  invalidateStateCache();

  return { ok: true, archived: archived, weeksScanned: completedWeeks.length };
}

function apiAdminFetchResults(payload) {
  requireAdmin(payload);
  const week = Number(payload.week);
  const games = sheetToObjects(SHEET_NAMES.GAMES).filter(g => Number(g.week) === week);
  // Fetch the scoreboard for the dates this week's games were actually played.
  // A bare fetchEspnScoreboard() returns ESPN's *current* week, so fetching last
  // week's results after ESPN rolled over used to find nothing.
  const events = fetchEspnEventsForGames_(games);
  const updates = [];
  const gameChanges = [];
  games.forEach(g => {
    let ev = g.espnEventId ? events.find(e => String(e.id) === String(g.espnEventId)) : null;
    if (!ev) {
      const match = matchEspnEvent(events, g.awayTeam, g.homeTeam);
      if (match) ev = events.find(e => e.id === match.eventId);
    }
    if (!ev) { updates.push({ gameId: g.gameId, found: false }); return; }
    const comp = ev.competitions[0];
    const competitors = comp.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home');
    const away = competitors.find(c => c.homeAway === 'away');
    const isFinal = comp.status && comp.status.type && comp.status.type.completed;
    if (isFinal && home && away) {
      gameChanges.push({ match: r => r.gameId === g.gameId, updates: {
        finalHomeScore: Number(home.score), finalAwayScore: Number(away.score), isFinal: true,
        homeLogo: g.homeLogo || extractTeamLogo(home.team), awayLogo: g.awayLogo || extractTeamLogo(away.team)
      } });
      updates.push({ gameId: g.gameId, found: true, final: true, homeScore: home.score, awayScore: away.score });
    } else {
      // even if not final yet, opportunistically save logos if they're missing
      // (guarded: home/away can be missing on malformed ESPN events, which used to throw mid-loop)
      if ((!g.homeLogo || !g.awayLogo) && home && away) {
        gameChanges.push({ match: r => r.gameId === g.gameId, updates: {
          homeLogo: g.homeLogo || extractTeamLogo(home.team), awayLogo: g.awayLogo || extractTeamLogo(away.team)
        } });
      }
      updates.push({ gameId: g.gameId, found: true, final: false });
    }
  });
  // one sheet read + only changed rows written (was a full Games re-read per game)
  updateRowsByMatchBatch_(SHEET_NAMES.GAMES, gameChanges);
  // Auto-archive perfect weeks for this week now that results are in.
  // (Previously passed playerId/isAdmin, but requireAdmin checks adminId -- so this
  // threw every time and the empty catch hid it: perfect weeks never auto-archived.)
  try { archivePerfectWeeks_(week); } catch(e) { Logger.log('Perfect week auto-archive failed: ' + e.message); }
  return { ok: true, updates };
}

// Fetches ESPN events covering the kickoff dates of the given games (max 14-day
// span, fetched in parallel). Falls back to ESPN's current scoreboard when no game
// has a usable kickoff date.
function fetchEspnEventsForGames_(games) {
  const times = games.map(g => g.kickoff ? new Date(g.kickoff).getTime() : NaN).filter(t => !isNaN(t));
  if (times.length === 0) return fetchEspnScoreboard();
  const min = new Date(Math.min.apply(null, times));
  let max = new Date(Math.max.apply(null, times));
  if (max - min > 14 * 86400000) max = new Date(min.getTime() + 14 * 86400000);
  const events = fetchEspnScoreboardRange(formatYYYYMMDD(min), formatYYYYMMDD(max));
  // safety net: if the dated fetch came back empty (ESPN hiccup), use the current scoreboard
  return events.length ? events : fetchEspnScoreboard();
}

function apiAdminOverrideResult(payload) {
  requireAdmin(payload);
  const found = updateRowByMatch(SHEET_NAMES.GAMES, r => r.gameId === payload.gameId, {
    finalHomeScore: Number(payload.homeScore), finalAwayScore: Number(payload.awayScore), isFinal: true
  });
  return { ok: found };
}

// apply "favorite by default" for any active player missing a pick once a week has started/locked
// Core logic: fills in the favorite as a straight pick for anyone missing one,
// for every game in the given week. Shared by the manual admin action below and
// the automatic scheduled trigger (applyWeeklyDefaults), so there's exactly one
// place this logic lives rather than two copies that could drift apart.
function applyNoPickDefaults_(week) {
  // Exclude external games (created when a player searches for an Upset Special
  // pick outside this week's 10-game board) -- those were never meant to have a
  // straight pick at all, so defaulting them to the favorite is always wrong.
  const games = sheetToObjects(SHEET_NAMES.GAMES).filter(g => Number(g.week) === week && g.source !== 'external');
  const players = sheetToObjects(SHEET_NAMES.PLAYERS).filter(p => p.active);
  // Script lock: this used to run unlocked, so an overlapping submitPicks (or the
  // trigger + the admin button at once) could insert duplicate straight picks.
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    invalidateSheetCache(SHEET_NAMES.PICKS); // re-read inside the lock
    const existingPicks = sheetToObjects(SHEET_NAMES.PICKS).filter(p => Number(p.week) === week);
    const newRows = [];
    players.forEach(player => {
      const playerPicks = existingPicks.filter(p => p.playerId === player.id);
      games.forEach(g => {
        const already = playerPicks.find(p => p.gameId === g.gameId && !(p.isUpset === true || p.isUpset === 'TRUE'));
        if (!already && g.favorite) {
          newRows.push({ week, playerId: player.id, gameId: g.gameId, pickedTeam: g.favorite, isUpset: false, isAutoDefault: true, submittedAt: new Date().toISOString() });
        }
      });
    });
    // one setValues for all defaults (was ~3 spreadsheet calls per pick -- up to 1,500 calls)
    appendObjects_(SHEET_NAMES.PICKS, newRows);
    invalidateStateCache();
    return newRows.length;
  } finally {
    releaseLock_(lock);
  }
}

function apiAdminApplyNoPickDefaults(payload) {
  requireAdmin(payload);
  const week = Number(payload.week);
  const count = applyNoPickDefaults_(week);
  return { ok: true, defaultsApplied: count };
}

// ---------- LEDGER ----------

function apiAdminLedgerEntry(payload) {
  requireAdmin(payload);
  appendObject(SHEET_NAMES.LEDGER, {
    playerId: payload.playerId, season: payload.season || getSeasonConfig().year,
    type: payload.type, amount: Number(payload.amount), note: payload.note || '', date: new Date().toISOString()
  });
  return { ok: true };
}

// (perfect_bonus is no longer paid; old rows of that type stay in the Ledger as history)
var LEDGER_TYPES_ = { paid: 1, payout: 1, weekly_prize: 1, bowl_paid: 1, bowl_payout: 1 };

// Several ledger rows in one write (the admin's "Week N prizes" card). Under the script
// lock, rows that already exist (same player + type + note + season) are skipped, so a
// double tap or a retry after a lost reply can never pay a week twice.
function apiAdminLedgerBatch(payload) {
  requireAdmin(payload);
  var season = payload.season || getSeasonConfig().year;
  var entries = payload.entries || [];
  if (!entries.length) return { ok: false, error: 'Nothing to record.' };
  for (var i = 0; i < entries.length; i++) {
    var en = entries[i];
    if (!en.playerId || !LEDGER_TYPES_[en.type] || !(Number(en.amount) > 0) || !String(en.note || '').trim()) {
      return { ok: false, error: 'Each entry needs a player, a type, an amount above 0 and a note.' };
    }
  }
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) {
    return { ok: false, error: 'Another save is still processing -- please try again in a moment.' };
  }
  try {
    invalidateSheetCache(SHEET_NAMES.LEDGER); // re-read inside the lock
    var seen = {};
    var keyOf = function(r) { return [r.playerId, r.type, String(r.note || '').trim(), String(r.season)].join('|'); };
    sheetToObjects(SHEET_NAMES.LEDGER).forEach(function(r) { seen[keyOf(r)] = true; });
    var now = new Date().toISOString();
    var rows = [], skipped = 0;
    entries.forEach(function(en) {
      var row = { playerId: en.playerId, season: season, type: en.type, amount: Number(en.amount), note: String(en.note).trim(), date: now };
      if (seen[keyOf(row)]) { skipped++; return; }
      seen[keyOf(row)] = true;
      rows.push(row);
    });
    appendObjects_(SHEET_NAMES.LEDGER, rows);
    return { ok: true, recorded: rows.length, skipped: skipped };
  } finally {
    releaseLock_(lock);
  }
}

// ---------- REGULAR SEASON STANDINGS ----------

function apiGetStandings(payload) {
  return { ok: true, standings: computeRegularStandings() };
}

// Determines which team COVERED THE SPREAD for a finished game — this is what
// straight (non-upset) picks are actually scored against, per league rules
// ("straight picks against the spread"). This is NOT the same as who won the
// game outright: a favorite can win and still fail to cover, and an underdog
// can lose and still cover (or win outright, which always covers too).
function computeCoveringTeam_(g) {
  var homeScore = Number(g.finalHomeScore), awayScore = Number(g.finalAwayScore);
  var favorite = g.favorite;
  var underdog = favorite === g.homeTeam ? g.awayTeam : g.homeTeam;
  var spread = Number(g.spread) || 0;
  var favMargin = (favorite === g.homeTeam) ? (homeScore - awayScore) : (awayScore - homeScore);
  return favMargin > spread ? favorite : underdog;
}

function computeRegularStandings() {
  const players = sheetToObjects(SHEET_NAMES.PLAYERS);
  // Week 0 is practice and must never count toward season standings, same as it's
  // already excluded from Perfect Week trophies elsewhere in the codebase.
  const games = sheetToObjects(SHEET_NAMES.GAMES).filter(g => (g.isFinal === true || g.isFinal === 'TRUE') && Number(g.week) > 0);
  const picks = sheetToObjects(SHEET_NAMES.PICKS);

  const standings = {};
  players.forEach(p => standings[p.id] = {
    playerId: p.id, name: p.name, teamName: p.teamName,
    points: 0, correct: 0, upsetWins: 0, weeklyBreakdown: {}
  });

  // group picks by game once (was a full scan of every pick for every final game)
  const picksByGame = {};
  picks.forEach(p => { (picksByGame[p.gameId] = picksByGame[p.gameId] || []).push(p); });

  games.forEach(g => {
    const homeScore = Number(g.finalHomeScore), awayScore = Number(g.finalAwayScore);
    const winner = homeScore > awayScore ? g.homeTeam : (awayScore > homeScore ? g.awayTeam : 'TIE');
    const favorite = g.favorite;
    const underdog = favorite === g.homeTeam ? g.awayTeam : g.homeTeam;
    const spread = Number(g.spread) || 0;
    const coveringTeam = computeCoveringTeam_(g);
    const gamePicks = picksByGame[g.gameId] || [];

    gamePicks.forEach(p => {
      if (!standings[p.playerId]) return;
      const isUpset = p.isUpset === true || p.isUpset === 'TRUE';
      const wk = Number(p.week);
      if (!standings[p.playerId].weeklyBreakdown[wk]) standings[p.playerId].weeklyBreakdown[wk] = 0;
      if (isUpset) {
        if (winner === underdog && winner !== 'TIE') {
          standings[p.playerId].points += spread;
          standings[p.playerId].upsetWins += 1;
          standings[p.playerId].weeklyBreakdown[wk] += spread;
        }
      } else {
        if (p.pickedTeam === coveringTeam) {
          standings[p.playerId].points += 1;
          standings[p.playerId].correct += 1;
          standings[p.playerId].weeklyBreakdown[wk] += 1;
        }
      }
    });
  });

  return Object.values(standings).sort((a, b) => b.points - a.points);
}

// =================================================================
// BOWL BONANZA
// =================================================================

// ---------- ADMIN: SET UP GAMES FOR A PHASE ----------

// phase = 'round1' (41 games, admin pulls schedule by date range) | 'quarter' (4 games, admin enters manually)
// | 'semi' (2 games, admin enters manually)
function apiAdminSetBowlGames(payload) {
  requireAdmin(payload);
  const phase = payload.phase;
  const games = payload.games || []; // [{slot, awayTeam, homeTeam}]
  const expectedCounts = { round1: 41, quarter: 4, semi: 2 };
  if (expectedCounts[phase] && games.length !== expectedCounts[phase]) {
    return { ok: false, error: `Phase "${phase}" requires exactly ${expectedCounts[phase]} games.` };
  }
  deleteRowsByMatch(SHEET_NAMES.BOWL_GAMES, g => g.phase === phase && g.locked !== true && g.locked !== 'TRUE');
  // one batched append (was 41 x ~3 spreadsheet calls for round 1)
  appendObjects_(SHEET_NAMES.BOWL_GAMES, games.map((g, idx) => ({
    phase, slot: g.slot || (idx + 1), gameId: genId('bg'), espnEventId: '',
    awayTeam: g.awayTeam, homeTeam: g.homeTeam, favorite: '', spread: '', source: '',
    kickoff: '', locked: false, finalAwayScore: '', finalHomeScore: '', isFinal: false, postedAt: ''
  })));
  setSeasonConfig('bowlCurrentPhase', phase);
  return { ok: true };
}

function apiAdminClearBowlPhase(payload) {
  requireAdmin(payload);
  const phase = payload.phase;
  // clear games, picks, and (for semi) champion picks for this phase so the admin can re-enter the next round.
  // BowlPicks can hold ~2,000 rows for round 1 -- the fast rewrite does it in one
  // read + one write (row-by-row deletes could exceed the 6-minute limit). Locked
  // because the fast rewrite would otherwise drop a pick submitted mid-clear.
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    deleteRowsByMatch(SHEET_NAMES.BOWL_GAMES, g => g.phase === phase);
    deleteRowsByMatchFast_(SHEET_NAMES.BOWL_PICKS, p => p.phase === phase);
    invalidateSheetCache(SHEET_NAMES.BOWL_PICKS);
    if (phase === 'semi') {
      deleteRowsByMatchFast_(SHEET_NAMES.BOWL_CHAMPION, c => true);
      invalidateSheetCache(SHEET_NAMES.BOWL_CHAMPION);
      setSeasonConfig('bowlChampionWinner', '');
    }
  } finally {
    releaseLock_(lock);
  }
  return { ok: true };
}

function apiAdminFetchBowlEspnLines(payload) {
  requireAdmin(payload);
  const phase = payload.phase;
  const games = sheetToObjects(SHEET_NAMES.BOWL_GAMES).filter(g => g.phase === phase);
  // bowl/playoff games span many days -- search a generous window if provided, else default scoreboard
  const events = payload.startDate && payload.endDate
    ? fetchEspnScoreboardRange(payload.startDate, payload.endDate)
    : fetchEspnScoreboard();
  const updated = [];
  const changes = [];
  games.forEach(g => {
    const match = matchEspnEvent(events, g.awayTeam, g.homeTeam);
    if (match) {
      changes.push({ match: r => r.gameId === g.gameId, updates: {
        espnEventId: match.eventId, favorite: match.favorite, spread: match.spread, source: 'espn', kickoff: match.kickoff,
        homeLogo: match.homeLogo, awayLogo: match.awayLogo
      } });
      updated.push({ gameId: g.gameId, favorite: match.favorite, spread: match.spread, matched: true });
    } else {
      updated.push({ gameId: g.gameId, matched: false });
    }
  });
  updateRowsByMatchBatch_(SHEET_NAMES.BOWL_GAMES, changes);
  return { ok: true, updated };
}

function apiAdminOverrideBowlLine(payload) {
  requireAdmin(payload);
  const updates = { favorite: payload.favorite, spread: payload.spread, source: 'manual' };
  if (payload.kickoff) updates.kickoff = payload.kickoff;
  const found = updateRowByMatch(SHEET_NAMES.BOWL_GAMES, r => r.gameId === payload.gameId, updates);
  return { ok: found };
}

function apiAdminPostBowlPhase(payload) {
  requireAdmin(payload);
  const phase = payload.phase;
  const games = sheetToObjects(SHEET_NAMES.BOWL_GAMES).filter(g => g.phase === phase);
  const missing = games.find(g => g.favorite === '' || g.spread === '' || g.kickoff === '');
  if (missing) return { ok: false, error: 'Every game in this phase needs a favorite, spread, and kickoff before posting.' };
  const postedAt = new Date().toISOString();
  updateRowsByMatchBatch_(SHEET_NAMES.BOWL_GAMES, games.map(g => ({ match: r => r.gameId === g.gameId, updates: { locked: true, postedAt: postedAt } })));
  setSeasonConfig('bowlCurrentPhase', phase);
  return { ok: true };
}

// ---------- PLAYER: BOWL PICKS ----------

function apiSubmitBowlPicks(payload) {
  const phase = payload.phase;
  const playerId = payload.playerId;
  const picks = payload.picks || []; // [{gameId, pickedTeam, isUpset}]
  const phaseGames = sheetToObjects(SHEET_NAMES.BOWL_GAMES).filter(g => g.phase === phase);
  if (phaseGames.length === 0 || phaseGames.some(g => g.locked !== true && g.locked !== 'TRUE')) {
    return { ok: false, error: 'This phase is not posted yet.' };
  }
  const expectedCounts = { round1: 41, quarter: 4, semi: 2 };
  const expectedUpsets = { round1: 2, quarter: 0, semi: 0 };
  const straightPicks = picks.filter(p => !p.isUpset);
  if (straightPicks.length !== expectedCounts[phase]) {
    return { ok: false, error: `You must submit a pick for all ${expectedCounts[phase]} games.` };
  }
  const upsetPicks = picks.filter(p => p.isUpset);
  if (upsetPicks.length !== expectedUpsets[phase]) {
    return { ok: false, error: `This phase requires exactly ${expectedUpsets[phase]} Upset Special picks.` };
  }
  const now = new Date();
  const existingPicksForPlayer = sheetToObjects(SHEET_NAMES.BOWL_PICKS).filter(ep => ep.phase === phase && ep.playerId === playerId);
  for (const p of picks) {
    const g = phaseGames.find(pg => pg.gameId === p.gameId);
    if (!g) continue;
    const existing = existingPicksForPlayer.find(ep => ep.gameId === p.gameId);
    const isUnchanged = existing && existing.pickedTeam === p.pickedTeam && (existing.isUpset === true || existing.isUpset === 'TRUE') === !!p.isUpset;
    if (isGameLockedServer(g, now) && !isUnchanged) {
      return { ok: false, error: `${g.awayTeam} @ ${g.homeTeam} has already locked (within 5 minutes of kickoff, started, or final) -- that pick can no longer be changed.` };
    }
    if (p.isUpset && String(g.favorite).trim() !== '' && p.pickedTeam === g.favorite) {
      return { ok: false, error: 'Your Upset Special pick must be the underdog, not the favorite.' };
    }
  }

  // Locked (same duplicate-row race that was already fixed for regular picks) and
  // batched: grouped deletes + one append instead of ~43 deleteRow + 43 x 3 append calls.
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) {
    return { ok: false, error: 'Another submission is still processing -- please try again in a moment.' };
  }
  try {
    deleteRowsByMatch(SHEET_NAMES.BOWL_PICKS, p => p.phase === phase && p.playerId === playerId);
    const submittedAt = new Date().toISOString();
    appendObjects_(SHEET_NAMES.BOWL_PICKS, picks.map(p => ({ phase, playerId, gameId: p.gameId, pickedTeam: p.pickedTeam, isUpset: !!p.isUpset, isAutoDefault: false, submittedAt: submittedAt })));
  } finally {
    releaseLock_(lock);
  }
  return { ok: true };
}

function apiSubmitBowlChampion(payload) {
  const playerId = payload.playerId;
  const teamPicked = payload.teamPicked;
  // locked so a double-tap can't leave two champion rows (duplicates were double-counted)
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) {
    return { ok: false, error: 'Another submission is still processing -- please try again in a moment.' };
  }
  try {
    deleteRowsByMatch(SHEET_NAMES.BOWL_CHAMPION, c => c.playerId === playerId);
    appendObject(SHEET_NAMES.BOWL_CHAMPION, { playerId, teamPicked, isAutoDefault: false, submittedAt: new Date().toISOString() });
  } finally {
    releaseLock_(lock);
  }
  return { ok: true };
}

// ---------- ADMIN: BOWL RESULTS ----------

function apiAdminFetchBowlResults(payload) {
  requireAdmin(payload);
  const phase = payload.phase;
  const games = sheetToObjects(SHEET_NAMES.BOWL_GAMES).filter(g => g.phase === phase);
  const events = payload.startDate && payload.endDate
    ? fetchEspnScoreboardRange(payload.startDate, payload.endDate)
    : fetchEspnScoreboard();
  const updates = [];
  const changes = [];
  games.forEach(g => {
    let ev = g.espnEventId ? events.find(e => String(e.id) === String(g.espnEventId)) : null;
    if (!ev) {
      const match = matchEspnEvent(events, g.awayTeam, g.homeTeam);
      if (match) ev = events.find(e => e.id === match.eventId);
    }
    if (!ev) { updates.push({ gameId: g.gameId, found: false }); return; }
    const comp = ev.competitions[0];
    const competitors = comp.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home');
    const away = competitors.find(c => c.homeAway === 'away');
    const isFinal = comp.status && comp.status.type && comp.status.type.completed;
    if (isFinal && home && away) {
      changes.push({ match: r => r.gameId === g.gameId, updates: {
        finalHomeScore: Number(home.score), finalAwayScore: Number(away.score), isFinal: true,
        homeLogo: g.homeLogo || extractTeamLogo(home.team), awayLogo: g.awayLogo || extractTeamLogo(away.team)
      } });
      updates.push({ gameId: g.gameId, found: true, final: true, homeScore: home.score, awayScore: away.score });
    } else {
      if (home && away && (!g.homeLogo || !g.awayLogo)) {
        changes.push({ match: r => r.gameId === g.gameId, updates: {
          homeLogo: g.homeLogo || extractTeamLogo(home.team), awayLogo: g.awayLogo || extractTeamLogo(away.team)
        } });
      }
      updates.push({ gameId: g.gameId, found: true, final: false });
    }
  });
  updateRowsByMatchBatch_(SHEET_NAMES.BOWL_GAMES, changes);
  return { ok: true, updates };
}

function apiAdminOverrideBowlResult(payload) {
  requireAdmin(payload);
  const found = updateRowByMatch(SHEET_NAMES.BOWL_GAMES, r => r.gameId === payload.gameId, {
    finalHomeScore: Number(payload.homeScore), finalAwayScore: Number(payload.awayScore), isFinal: true
  });
  return { ok: found };
}

// no-pick default = favorite, for any active player missing a pick in a posted phase
function apiAdminApplyBowlNoPickDefaults(payload) {
  requireAdmin(payload);
  const phase = payload.phase;
  const games = sheetToObjects(SHEET_NAMES.BOWL_GAMES).filter(g => g.phase === phase);
  const players = sheetToObjects(SHEET_NAMES.PLAYERS).filter(p => p.active);
  // locked + batched (was up to ~2,000 appendObject calls for round 1, unlocked)
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let count = 0;
  try {
    invalidateSheetCache(SHEET_NAMES.BOWL_PICKS);
    const existingPicks = sheetToObjects(SHEET_NAMES.BOWL_PICKS).filter(p => p.phase === phase);
    const pickRows = [];
    players.forEach(player => {
      const playerPicks = existingPicks.filter(p => p.playerId === player.id);
      games.forEach(g => {
        const already = playerPicks.find(p => p.gameId === g.gameId);
        if (!already && g.favorite) {
          pickRows.push({ phase, playerId: player.id, gameId: g.gameId, pickedTeam: g.favorite, isUpset: false, isAutoDefault: true, submittedAt: new Date().toISOString() });
        }
      });
    });
    appendObjects_(SHEET_NAMES.BOWL_PICKS, pickRows);
    count += pickRows.length;
    // champion no-pick default (semi phase only): favorite among the 4 semifinal teams by aggregate is ambiguous,
    // so default to the favorite of semi game 1's favorite team
    if (phase === 'semi') {
      const semiGames = games;
      const champPicks = sheetToObjects(SHEET_NAMES.BOWL_CHAMPION);
      const defaultChamp = semiGames.length > 0 ? semiGames[0].favorite : '';
      const champRows = [];
      players.forEach(player => {
        const already = champPicks.find(c => c.playerId === player.id);
        if (!already && defaultChamp) {
          champRows.push({ playerId: player.id, teamPicked: defaultChamp, isAutoDefault: true, submittedAt: new Date().toISOString() });
        }
      });
      appendObjects_(SHEET_NAMES.BOWL_CHAMPION, champRows);
      count += champRows.length;
    }
  } finally {
    releaseLock_(lock);
  }
  return { ok: true, defaultsApplied: count };
}

// ---------- BOWL LEDGER ----------

function apiAdminBowlLedgerEntry(payload) {
  requireAdmin(payload);
  appendObject(SHEET_NAMES.BOWL_LEDGER, {
    playerId: payload.playerId, season: payload.season || getSeasonConfig().year,
    type: payload.type, amount: Number(payload.amount), note: payload.note || '', date: new Date().toISOString()
  });
  return { ok: true };
}

// ---------- BOWL STANDINGS ----------

function apiGetBowlStandings(payload) {
  return { ok: true, standings: computeBowlStandings() };
}

function computeBowlStandings() {
  const players = sheetToObjects(SHEET_NAMES.PLAYERS);
  const games = sheetToObjects(SHEET_NAMES.BOWL_GAMES).filter(g => g.isFinal === true || g.isFinal === 'TRUE');
  const picks = sheetToObjects(SHEET_NAMES.BOWL_PICKS);
  const champPicks = sheetToObjects(SHEET_NAMES.BOWL_CHAMPION);

  // determine champion if national championship game result known: use the 'semi' phase winners is not
  // sufficient -- champion is resolved manually by admin once known via a season config flag, OR we infer
  // from the latest semi game results if there's a final round modeled as part of 'semi'. Since the prompt
  // doesn't define a distinct championship GAME (only a champion PICK), we resolve correctness via
  // Season config 'bowlChampionWinner' set by admin once the title game concludes.
  const cfg = getSeasonConfig();
  const actualChampion = cfg.bowlChampionWinner || '';

  const standings = {};
  players.forEach(p => standings[p.id] = {
    playerId: p.id, name: p.name, teamName: p.teamName, points: 0,
    round1Correct: 0, upsetWins: 0, quarterCorrect: 0, semiCorrect: 0, championCorrect: false
  });

  games.forEach(g => {
    const homeScore = Number(g.finalHomeScore), awayScore = Number(g.finalAwayScore);
    const winner = homeScore > awayScore ? g.homeTeam : (awayScore > homeScore ? g.awayTeam : 'TIE');
    const favorite = g.favorite;
    const underdog = favorite === g.homeTeam ? g.awayTeam : g.homeTeam;
    const spread = Number(g.spread) || 0;
    const pointValue = POINT_VALUES[g.phase] || 1;
    const gamePicks = picks.filter(p => p.gameId === g.gameId);

    gamePicks.forEach(p => {
      if (!standings[p.playerId]) return;
      const isUpset = p.isUpset === true || p.isUpset === 'TRUE';
      if (isUpset) {
        if (winner === underdog && winner !== 'TIE') {
          standings[p.playerId].points += spread;
          standings[p.playerId].upsetWins += 1;
        }
      } else if (p.pickedTeam === winner) {
        standings[p.playerId].points += pointValue;
        if (g.phase === 'round1') standings[p.playerId].round1Correct += 1;
        if (g.phase === 'quarter') standings[p.playerId].quarterCorrect += 1;
        if (g.phase === 'semi') standings[p.playerId].semiCorrect += 1;
      }
    });
  });

  if (actualChampion) {
    champPicks.forEach(c => {
      if (!standings[c.playerId]) return;
      if (c.teamPicked === actualChampion) {
        standings[c.playerId].points += POINT_VALUES.champion;
        standings[c.playerId].championCorrect = true;
      }
    });
  }

  const list = Object.values(standings);
  // tiebreaker: most correct of the 41 round1 games
  list.sort((a, b) => b.points - a.points || b.round1Correct - a.round1Correct);
  return list;
}

// ── Load Authoritative CareerHistory from Master Standings Data ───────────────
// This replaces rebuildCareerHistoryFromUpsetHistory() with verified data.
// Run once from Apps Script editor after deploying this Code.gs.
function loadAuthoritativeCareerHistory() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Build playerId lookup by teamName — normalized uppercase, spaces stripped
  var players = sheetToObjects('Players');
  var playerMap = {};
  players.forEach(function(p) {
    if (p.teamName) {
      var key = String(p.teamName).trim().toUpperCase().replace(/\s+/g,'');
      playerMap[key] = { id: String(p.id), name: p.name, teamName: p.teamName };
    }
  });

  // Also check approved NameClaims
  var claims = [];
  try { claims = sheetToObjects('NameClaims'); } catch(e) {}
  claims.filter(function(c){ return c.status === 'approved'; }).forEach(function(c) {
    var key = String(c.claimedTeamName||'').trim().toUpperCase().replace(/\s+/g,'');
    if (!playerMap[key]) playerMap[key] = { id: String(c.playerId), name: c.playerName, teamName: c.claimedTeamName };
  });

  function lookupPlayer(rawName) {
    var key = String(rawName||'').trim().toUpperCase().replace(/\s+/g,'');
    // Direct match
    if (playerMap[key]) return playerMap[key];
    // Fuzzy: try removing apostrophes, hyphens, special chars
    var clean = key.replace(/[^A-Z0-9]/g,'');
    for (var k in playerMap) {
      if (k.replace(/[^A-Z0-9]/g,'') === clean) return playerMap[k];
    }
    return null;
  }

  // THE AUTHORITATIVE DATA — pulled directly from master standings sheets
  var DATA = [
    // 2016
    [2016,'THE POUTING NEWTONS',136],[2016,'TEAM # 1',131.5],[2016,'SFCOMMO',121.5],
    [2016,'REX & ROB',118],[2016,'THE CUNNING LINGUISTS',114.5],[2016,'BOOOF',113],
    [2016,'RICO SUAVE',108.5],[2016,'DA HERD',108],[2016,'HARBAUGH 4 PRESIDENT',107],
    [2016,'MUSCHAMPS MINIONS',106],[2016,'BAMA',105],[2016,'DAWGS',104],
    [2016,'COCKS',103],[2016,'RUHOO',102.5],[2016,'GOBLUE',102],[2016,'VOLZ',101],
    [2016,'MOOGEE',100],[2016,'SOUTHSIDE HOKIES',100],[2016,'THE ELECTRIC MAYHEM',99],
    [2016,'RMC/HOKIE POOCH',98.5],[2016,'PICSIX',97],[2016,'BOOMER',94.5],
    [2016,'PONYTIME',94],[2016,'TRIPLE NICKEL',91.5],[2016,'AARON A',90],
    [2016,'HOOS',89],[2016,'VT',88.5],[2016,'HERNANDEZ\'S GUN',86],
    [2016,'SMURFTURF',85.5],[2016,'WVU PRIDE',85],[2016,'BIG CITY',84],
    [2016,'JOHNNY 8 BALLS',83],[2016,'MAKING IT DRIZZLE',79.5],[2016,'RADAR LOVE',75],
    [2016,'STRAIGHT CASH HOMEY',71.5],[2016,'HAIL SABAN',66],[2016,'BLAKE',66],
    // 2017
    [2017,'NEVER NERVOUS',125.5],[2017,'RUHOO',120.5],[2017,'GO BLUE',118.5],
    [2017,'TRIPLENICKEL',118],[2017,'SMURF TURF',113.5],[2017,'MOOGEE',113.5],
    [2017,'HERNANDEZ\'S GUN',108],[2017,'BAMA',106],[2017,'QUICK PICK',105],
    [2017,'VOLZ',102],[2017,'RICO SUAVE',97.5],[2017,'COCKS',95.5],
    [2017,'THE BURNER PHONES',94],[2017,'MARK & MARK',93.5],[2017,'VT',92.5],
    [2017,'MR FURLEY\'S LEISURE SUITS',92.5],[2017,'PONYTIME',91.5],
    [2017,'MAKING IT DRIZZLE',88.5],[2017,'REX & ROB',88],[2017,'HOOF HEARTED',88],
    [2017,'NATE DOGG',88],[2017,'BOOOF',87.5],[2017,'SFCOMMO',87.5],
    [2017,'SOUTHSIDE HOKIES',87.5],[2017,'RADAR LOVE',84],
    [2017,'HARBAUGH FOR PRESIDENT',84],[2017,'STRAIGHT CASH HOMIE',81],
    [2017,'CALIFOURNETTICATION',79],[2017,'DA\'HERD',77.5],[2017,'KELLY',77.5],
    [2017,'AARON A',74],
    // 2018
    [2018,'DAWGS',122],[2018,'VT',120],[2018,'BURT REYNOLD\'S MUSTACHE(RIP)',119.5],
    [2018,'URBAN\'S SWEET LITTLE LIES',118],[2018,'PONYTIME',113.5],
    [2018,'MAKING IT DRIZZLE',110],[2018,'NEVER NERVOUS',110],[2018,'LUKE',107],
    [2018,'NATE DOGG',104],[2018,'BROWNIES R BACK',101],[2018,'PICSIX',101],
    [2018,'MUFFED PUNT',100],[2018,'HARBAUGH FOR PRESIDENT',98.5],
    [2018,'LUKE FELKER',98.5],[2018,'BOOOF',98],[2018,'THE HERD',97],
    [2018,'POKEFAN',97],[2018,'RUHOO',96],[2018,'TAKE MY MONEY',94],
    [2018,'TRPLNCKL',94],[2018,'RADAR LOVE',94],[2018,'CODY113098',93.5],
    [2018,'POOCH\'S PITIFUL PICKS',91],[2018,'RICO',90.5],[2018,'BAMA',90],
    [2018,'VOLZ',88.5],[2018,'ALWAYS BE CLOSING',82],[2018,'AARON A',81],
    [2018,'GO BLUE1',79],[2018,'SOUTHSIDE HOKIES',74],[2018,'JOE DIRT',73.5],
    [2018,'SMURF TURF',57],[2018,'COCKS',42],
    // 2019
    [2019,'GOBLUE1',135.5],[2019,'VOLZ',130],[2019,'BROWNS NEED REX',127],
    [2019,'ALWAYS BE CLOSING',124.5],[2019,'PONYTIME',121.5],[2019,'TRPLNICKL',119.5],
    [2019,'NATEDOGG',119.5],[2019,'THE HERD',116],[2019,'RICO',112],
    [2019,'BOOOFEE',112],[2019,'CATHOLICS OVER CONVICTS',111.5],
    [2019,'HARDKNOCKERS',110.5],[2019,'VT',110],[2019,'RUHOO',109.5],
    [2019,'HIGH QUALITY H20',108],[2019,'POOCH\'S PICKS',105.5],
    [2019,'RADAR LOVE',105.5],[2019,'THE TRANSFER PORTALS',105],
    [2019,'SOUTHSIDE HOKIES',101.5],[2019,'J KISER',99.5],[2019,'AARON A',96],
    [2019,'HARBAUGH FOR PRESIDENT',96],[2019,'NEVER NERVOUS',94.5],
    [2019,'SMURF TURF',87.5],[2019,'HERNANDEZ\'S GUN',83],[2019,'THE TIDE',77],
    [2019,'DAWGS',76],[2019,'MAKINGITDRIZZLE',74],[2019,'HERD ON',68.5],
    // 2020
    [2020,'NATEDOGG',139.5],[2020,'AARON A',138],[2020,'BIDEN\'S SNIFFER',137],
    [2020,'CRUM',132.5],[2020,'HARBAUGH FOR PRESIDENT',123],
    [2020,'NEVER NERVOUS',119.5],[2020,'SNOWMAN',118],
    [2020,'SOUTHSIDE HOKIES',115.5],[2020,'MAKING IT DRIZZLE',115.5],
    [2020,'BROWNIES R BACK',115],[2020,'RADAR LOVE',115],[2020,'PONYTIME',110],
    [2020,'BOOOOF',108.5],[2020,'COACH SMITH',105.5],[2020,'REGGIE OLIVER',105],
    [2020,'T-TOWN',104.5],[2020,'DAHERD',103.5],[2020,'RUHOO',102],
    [2020,'COCKS',101.5],[2020,'TRIPLENICKEL',101],[2020,'VOLZ',100.5],
    [2020,'BFLOBILLYS',95.5],[2020,'HARDKNOCKERS',94],[2020,'VT',93],
    [2020,'A PLETHRA OF PINATAS',92],[2020,'GO HEELS',89],[2020,'JWALTERS',86.5],
    [2020,'MARK PUCCINELLI',84],[2020,'GOBLUE',69],
    // 2021
    [2021,'GOHEELS',129.5],[2021,'RUHOO',129],[2021,'AARONA',118],
    [2021,'IRISH MARK',114.5],[2021,'RISING TIDE',113],[2021,'ALWAYS BE CLOSING',110.5],
    [2021,'SNOWMAN',109.5],[2021,'TRPLNCKL',109],[2021,'WASHINGTON PICKEM TEAM',109],
    [2021,'HARBAUGH4PRESIDENT',106],[2021,'21-ACES SMITH',105.5],
    [2021,'MAKING IT DRIZZLE',102.5],[2021,'NEVER NERVOUS',102.5],
    [2021,'HARDKNOCKERS',101.5],[2021,'MOUNTAINEERS',101],[2021,'BROWNSRBACK',100.5],
    [2021,'SFCOMMO',100],[2021,'VOLZ',99.5],[2021,'DAHERD',97],
    [2021,'PONYTIME',96],[2021,'SLICK NICK',95.5],[2021,'PATRICK CRUM',93.5],
    [2021,'BFLOBILLYS',93],[2021,'BOOOF',93],[2021,'DECHAMDOUCHE',92],
    [2021,'SOUTHSIDE HOKIES',89.5],[2021,'DICK WARLOCK',87],[2021,'LUKE FELKER',86.5],
    [2021,'HOGS',86],[2021,'GOBLUE',85.5],[2021,'MONTANA',85.5],[2021,'VT',83.5],
    [2021,'JOEYS PICKS',82],[2021,'HARBAUGHS KHAKIS',80.5],[2021,'NATEDOGG',78],
    [2021,'RADAR LOVE',74.5],[2021,'JUICERS',74],
    // 2022
    [2022,'HARBAUGH4PRESIDENT',137.5],[2022,'RADAR LOVE',136.5],
    [2022,'MAKINGITDRIZZLE',135.5],[2022,'NATEDOGG',126],[2022,'GOBLUE',122],
    [2022,'WVU CREW',120],[2022,'LUKE FELKER',118.5],[2022,'TRPLNCKL',117],
    [2022,'GOHEELS',114.5],[2022,'MONTANA',113.5],[2022,'SNOWMAN',112.5],
    [2022,'ALWAYS BE CLOSING',111.5],[2022,'DAHERD',111.5],
    [2022,'BUFFALO BILLYS',110.5],[2022,'SOUTHSIDE HOKIES',109.5],[2022,'VT',106],
    [2022,'BROWNSRBACK',106],[2022,'RICO SUAVE',104],[2022,'NEVER NERVOUS',103],
    [2022,'RUHOO',103],[2022,'BOOOOF',101.5],[2022,'HIGHTIDE',100.5],
    [2022,'IRISH MARK',99.5],[2022,'VOLZ',97],[2022,'THE GLORY BOWL',92.5],
    [2022,'PUP LIST',91.5],[2022,'EDDIE MONEY',89],[2022,'PONYTIME',83],
    [2022,'PSYCADELIC TEDDY BEARS',78.5],[2022,'PATRICK CRUM',72],
    [2022,'AARONA',70],[2022,'HARDKNOCKERS',68],
    // 2023
    [2023,'NEVER NERVOUS',142],[2023,'TEAM CRUM',135.5],[2023,'RUHOO',134.5],
    [2023,'BFLOBILLYS',125.5],[2023,'NATEDOGG',125.5],[2023,'AARONA',124.5],
    [2023,'VT',124],[2023,'MAKING IT DRIZZLE',121.5],[2023,'PONYTIME',119.5],
    [2023,'HIGH TIDE',117],[2023,'BROWNIESRBACK',116.5],[2023,'GO BLUE',115.5],
    [2023,'MSFLOPPY',111.5],[2023,'RADAR LOVE',111],[2023,'HUNTER\'S LAPTOP',110],
    [2023,'SNOWMAN',107.5],[2023,'IRISH POOCH',106.5],[2023,'ALWAYS BE CLOSING',105],
    [2023,'VOLZ',102.5],[2023,'MOUNTAINEERS',101],[2023,'GOHEELS',101],
    [2023,'ITS ALL ABOUT THE U',101],[2023,'THE VIG',100.5],[2023,'ORACLE',98],
    [2023,'WINDY CITY BEN',93.5],[2023,'CHAFING THE DREAM',88],
    [2023,'HARBAUGH4PRESIDENT',87.5],[2023,'TRPLNCKL',86.5],[2023,'RICO SUAVE',83],
    [2023,'DAHERD',81.5],[2023,'KAVIKS TEAM',81],[2023,'HARDKNOCKERS',75],
    [2023,'SOUTHSIDE HOKIES',75],
    // 2024
    [2024,'ITS ALL ABOUT THE U',156.5],[2024,'ALWAYS BE CLOSING',156],
    [2024,'HERD TUAH',146.5],[2024,'BROWNSRBACK',146.5],[2024,'C\'PRIME',144.5],
    [2024,'HARBAUGH4PRESIDENT',141.5],[2024,'MOUNTAINEERS',139.5],
    [2024,'SOUTHSIDE HOKIES',137],[2024,'DAHERD',136.5],[2024,'KNEECAP BITER',136],
    [2024,'VT',133.5],[2024,'CHAFING THE DREAM',131.5],[2024,'MONTANA',131],
    [2024,'GOBLUE',121.5],[2024,'WINDYCITYBEN',121],[2024,'BEAMERSNECK',118],
    [2024,'RUHOO',116],[2024,'SNOWMAN',115],[2024,'NEVER NERVOUS',114.5],
    [2024,'HIGHTIDE',113],[2024,'HARDKNOCKERS',112.5],[2024,'SPUDS',112.5],
    [2024,'BFLOBILLYS',110],[2024,'NAMECHANGER',109.5],[2024,'RICO SUAVE',108.5],
    [2024,'VOLZ',108],[2024,'PONYTIME',106],[2024,'GOHEELS',105],
    [2024,'RADAR LOVE',105],[2024,'IRISH MARK',104.5],
    [2024,'EVERYDOGHASITSDAY',102.5],[2024,'FLOPPY',101.5],
    [2024,'TAPPAHANNOCK',101.5],[2024,'CORSO\'S HEADGEAR',101.5],
    [2024,'AARONA',100.5],[2024,'KISER',98],[2024,'KAVIK',97.5],
    [2024,'BUCKNUT',94],[2024,'NATEDOGG',91],[2024,'GATORSRBACK',90],
    [2024,'MAKINGITDRIZZLE',90],[2024,'TRPLNCKL',89],[2024,'BLIND SQUIRRELS',70],
    // 2025
    [2025,'GOATNESS',154.5],[2025,'HARBAUGH4PRESIDENT',146.5],[2025,'DAHERD',142],
    [2025,'DAWGS',138.5],[2025,'SAVEUSLAGWAY',138.5],[2025,'NAMECHANGER',138.5],
    [2025,'CPRIME',138],[2025,'SNAFU',134.5],[2025,'AARONA',132],
    [2025,'NATEDOGG',132],[2025,'RADARLOVE',131.5],[2025,'CADE-HEISNIK',130.5],
    [2025,'PONYTIME',130],[2025,'HARDKNOCKERS',127],[2025,'BUCKNUT',124.5],
    [2025,'BFLOBILLYS',124.5],[2025,'SHORELINE',121],[2025,'NATHAN',117.5],
    [2025,'GOBLUE',117.5],[2025,'RISINGTIDE',117.5],[2025,'BROWNSRBACK',117],
    [2025,'HOOFHEARTED',117],[2025,'RUHOO',116.5],[2025,'TRPLNCKL',116.5],
    [2025,'SOUTHSIDEHOKIES',112.5],[2025,'MOUNTAINEERS',112.5],[2025,'HERDGPT',112.5],
    [2025,'GOHEELS',112],[2025,'HARBAUGHSHEADNURSE',111],[2025,'ALWAYSBECLOSING',110.5],
    [2025,'TEAMBROOKS',108],[2025,'WOODY',106.5],[2025,'BRYONR',104],
    [2025,'LARRYBROWNSCRANK',102.5],[2025,'RICOSUAVE',101],[2025,'NEVERNERVOUS',100],
    [2025,'VOLZ',99],[2025,'TEAMWALTERS',96.5],[2025,'IRISHMARK',93.5],
    [2025,'MAKINGITDRIZZLE',93],[2025,'VT',87.5],[2025,'KNEECAPBITER',84],
    [2025,'ITSALLABOUTTHEU',83]
  ];

  // Build rows for CareerHistory sheet
  var rows = DATA.map(function(d) {
    var year = d[0], rawName = d[1], points = d[2];
    var linked = lookupPlayer(rawName);
    return [
      linked ? linked.id : '',
      linked ? linked.name : '',
      rawName,
      year,
      points,
      linked ? 'YES' : ''
    ];
  });

  // Write to CareerHistory — full replace
  var chSheet = ss.getSheetByName('CareerHistory');
  if (!chSheet) {
    chSheet = ss.insertSheet('CareerHistory');
  }
  chSheet.clearContents();
  chSheet.appendRow(['playerId','name','teamName','year','points','matched']);
  chSheet.getRange(2, 1, rows.length, 6).setValues(rows);
  invalidateCareerHistoryCache();

  // Summary
  var linked = rows.filter(function(r){ return r[0]; }).length;
  var unlinked = rows.filter(function(r){ return !r[0]; }).length;
  Logger.log('CareerHistory loaded: ' + rows.length + ' total rows (' + linked + ' linked, ' + unlinked + ' unlinked)');
  Logger.log('Run runCareerHistoryAudit() to verify.');
}


// ═══════════════════════════════════════════════════════════════════════════════
// EMAIL CENTER — template sending, custom composer, AI results emails
// ═══════════════════════════════════════════════════════════════════════════════

// Tony's email template folder. Override anytime by adding EMAIL_TEMPLATE_FOLDER_ID
// to Script Properties — that wins over this default.
var EMAIL_FOLDER_ID   = '1vw3_SfXi7gXddzwTvxasl3rYHPuspzpX';
var EMAIL_FOLDER_NAME = 'UpsetSpecial Email Templates';
var EMAIL_LOGO_URL    = 'https://acebuilds51.github.io/UpsetSpecial/email-logo.png?v=2';
var EMAIL_APP_URL     = 'https://acebuilds51.github.io/UpsetSpecial';
var FEEDBACK_FORM_URL = 'https://forms.gle/LGaegETjjhnTcZum9';
var JEFF_EMAIL = 'jeffsellshomesrva@gmail.com';

// Resolve the template folder: Script Property > hardcoded ID > name search > create.
function getEmailTemplateFolder_() {
  var propId = PropertiesService.getScriptProperties().getProperty('EMAIL_TEMPLATE_FOLDER_ID');
  var tryIds = [propId, EMAIL_FOLDER_ID];
  for (var i = 0; i < tryIds.length; i++) {
    if (!tryIds[i]) continue;
    try { return DriveApp.getFolderById(tryIds[i]); } catch (e) {}
  }
  var it = DriveApp.getFoldersByName(EMAIL_FOLDER_NAME);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(EMAIL_FOLDER_NAME);
}

// ── RUN THIS ONCE FROM THE EDITOR ─────────────────────────────────────────────
// Editor -> select "setupEmailTemplates" -> Run.
// Grants Drive access and confirms the app can see your template files.
function setupEmailTemplates() {
  var folder = getEmailTemplateFolder_();
  Logger.log('Folder: ' + folder.getName());
  Logger.log('URL:    ' + folder.getUrl());
  var files = folder.getFiles();
  var n = 0;
  while (files.hasNext()) {
    var f = files.next();
    if (f.getName().toLowerCase().indexOf('.html') < 0) continue;
    n++;
    Logger.log('  ' + n + '. ' + f.getName() + '  (' + Math.round(f.getSize() / 1024) + ' KB)');
  }
  Logger.log(n === 0
    ? 'NO .html FILES FOUND — upload your email templates to this folder.'
    : 'READY — ' + n + ' template(s) will appear in the app.');
  Logger.log('Mail quota remaining today: ' + MailApp.getRemainingDailyQuota());
  return n;
}

// List every .html file in the template folder.
function apiAdminListEmailTemplates(payload) {
  requireAdmin(payload);
  try {
    var folder = getEmailTemplateFolder_();
    var files = folder.getFiles();
    var out = [];
    while (files.hasNext()) {
      var f = files.next();
      var name = f.getName();
      if (name.toLowerCase().indexOf('.html') < 0) continue;
      out.push({
        id: f.getId(),
        name: name.replace(/\.html$/i, ''),
        size: f.getSize(),
        updated: f.getLastUpdated().toISOString()
      });
    }
    out.sort(function(a, b) { return a.name.localeCompare(b.name); });
    return {
      ok: true,
      templates: out,
      folderUrl: folder.getUrl(),
      quota: MailApp.getRemainingDailyQuota()
    };
  } catch (e) {
    return { ok: false, error: 'Could not read template folder: ' + e.message };
  }
}

// Pull one template's HTML for preview.
function apiAdminGetEmailTemplate(payload) {
  requireAdmin(payload);
  if (!payload.templateId) return { ok: false, error: 'Missing templateId.' };
  try {
    var file = DriveApp.getFileById(payload.templateId);
    return { ok: true, name: file.getName(), html: file.getBlob().getDataAsString() };
  } catch (e) {
    return { ok: false, error: 'Could not read template: ' + e.message };
  }
}

// Collect recipient emails. testOnly => just the requesting admin.
function getEmailRecipients_(payload, testOnly) {
  var players = sheetToObjects(SHEET_NAMES.PLAYERS);
  if (testOnly) {
    var me = players.find(function(p) { return p.id === payload.adminId || p.id === payload.playerId; });
    return (me && me.email) ? [me.email] : [];
  }
  if (payload.audience === 'specific') {
    var ids = payload.playerIds || [];
    var chosen = players.filter(function(p) { return ids.indexOf(p.id) !== -1 && p.email && String(p.email).indexOf('@') > 0; });
    return chosen.map(function(p) { return String(p.email).trim(); });
  }
  var pool = players.filter(function(p) { return p.active && p.email && String(p.email).indexOf('@') > 0; });
  if (payload.audience === 'notInstalled') {
    pool = pool.filter(function(p) { return !p.installedAt; });
  }
  return pool.map(function(p) { return String(p.email).trim(); });
}

// Log every send so there's a paper trail.
function logEmailSend_(subject, count, kind, who) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('EmailLog');
    if (!sheet) {
      sheet = ss.insertSheet('EmailLog');
      sheet.appendRow(['sentAt', 'subject', 'recipients', 'kind', 'sentBy']);
    }
    sheet.appendRow([new Date().toISOString(), subject, count, kind, who || '']);
  } catch (e) { Logger.log('EmailLog write failed: ' + e.message); }
}

// Send a pre-built template file to the league (or just yourself as a test).
function apiAdminSendTemplateEmail(payload) {
  requireAdmin(payload);
  var subject = String(payload.subject || '').trim();
  if (!subject) return { ok: false, error: 'Subject is required.' };
  if (!payload.templateId) return { ok: false, error: 'Missing templateId.' };

  var html;
  try {
    html = DriveApp.getFileById(payload.templateId).getBlob().getDataAsString();
  } catch (e) {
    return { ok: false, error: 'Could not read template: ' + e.message };
  }

  var testOnly = !!payload.testOnly;
  var recipients = getEmailRecipients_(payload, testOnly);
  if (recipients.length === 0) {
    return { ok: false, error: testOnly ? 'No email address on your player record.' : 'No active players with email addresses.' };
  }

  var quota = MailApp.getRemainingDailyQuota();
  if (quota < recipients.length) {
    return { ok: false, error: 'Daily email quota too low. Remaining: ' + quota + ', needed: ' + recipients.length + '. Try again tomorrow.' };
  }

  var sent = 0, failed = [];
  recipients.forEach(function(addr) {
    try {
      MailApp.sendEmail({ to: addr, subject: subject, htmlBody: html, name: 'Upset Special League' });
      sent++;
    } catch (e) {
      failed.push(addr);
      Logger.log('Send failed to ' + addr + ': ' + e.message);
    }
  });

  logEmailSend_(subject, sent, testOnly ? 'template-test' : 'template', payload.adminId);
  return { ok: true, sent: sent, failed: failed, testOnly: testOnly, quotaLeft: MailApp.getRemainingDailyQuota() };
}

// Wrap body HTML in the standard Upset Special header/footer shell.
function buildEmailHtml(title, subtitle, bodyHtml) {
  return '' +
'<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>' + escapeHtmlGs_(title) + '</title></head>' +
'<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;color:#1a1a2e;">' +
'<div style="max-width:620px;margin:0 auto;">' +
  '<table width="100%" cellpadding="0" cellspacing="0" style="background:#1a1a2e;"><tr><td style="padding:18px 24px;text-align:center;">' +
    '<table cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr>' +
      '<td style="vertical-align:middle;padding-right:14px;"><img src="' + EMAIL_LOGO_URL + '" style="height:56px;width:auto;display:block;border-radius:8px;" alt="Upset Special"></td>' +
      '<td style="vertical-align:middle;"><span style="font-family:Arial Black,Arial,sans-serif;font-size:28px;font-weight:900;color:#ffffff;">UPSET </span>' +
      '<span style="font-family:Arial Black,Arial,sans-serif;font-size:28px;font-weight:900;color:#FFB800;">SPECIAL</span></td>' +
    '</tr></table>' +
  '</td></tr></table>' +
  '<div style="background:linear-gradient(135deg,#FFB800 0%,#FF6B35 100%);padding:34px 24px;text-align:center;">' +
    '<h1 style="margin:0 0 10px;font-size:26px;font-weight:900;color:#1A1206;line-height:1.25;font-family:Arial Black,Arial,sans-serif;">' + title + '</h1>' +
    (subtitle ? '<p style="margin:0;font-size:15px;color:#1A1206;opacity:0.85;line-height:1.5;">' + subtitle + '</p>' : '') +
  '</div>' +
  '<div style="padding:28px 32px;font-size:15px;line-height:1.7;color:#1a1a2e;background:#fff;">' + bodyHtml + '</div>' +
  '<div style="background:#f7f7fb;border-top:1px solid #ebe5d8;padding:18px 28px;font-size:12px;color:#8c97ac;text-align:center;line-height:1.6;">' +
    'Upset Special League &middot; <a href="' + EMAIL_APP_URL + '" style="color:#d4792a;">Open App</a> &middot; ' +
    '<a href="' + EMAIL_APP_URL + '/help.html" style="color:#d4792a;">Player Guide</a> &middot; ' +
    '<a href="' + FEEDBACK_FORM_URL + '" style="color:#d4792a;">Feedback</a>' +
  '</div>' +
'</div></body></html>';
}

function escapeHtmlGs_(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Free-form email composed in the app.
function apiAdminSendCustomEmail(payload) {
  requireAdmin(payload);
  var subject  = String(payload.subject || '').trim();
  var title    = String(payload.title || '').trim();
  var subtitle = String(payload.subtitle || '').trim();
  var body     = String(payload.bodyHtml || '').trim();

  if (!subject) return { ok: false, error: 'Subject is required.' };
  if (!title)   return { ok: false, error: 'Headline is required.' };
  if (!body)    return { ok: false, error: 'Message body is required.' };

  var html = buildEmailHtml(title, subtitle, body);
  var testOnly = !!payload.testOnly;
  var recipients = getEmailRecipients_(payload, testOnly);
  if (recipients.length === 0) {
    var noRecipMsg = testOnly ? 'No email address on your player record.'
      : (payload.audience === 'specific' ? 'No players selected, or none of the selected players have an email address on file.'
      : 'No active players with email addresses.');
    return { ok: false, error: noRecipMsg };
  }

  var quota = MailApp.getRemainingDailyQuota();
  if (quota < recipients.length) {
    return { ok: false, error: 'Daily email quota too low. Remaining: ' + quota + ', needed: ' + recipients.length + '.' };
  }

  var sent = 0, failed = [];
  recipients.forEach(function(addr) {
    try {
      MailApp.sendEmail({ to: addr, subject: subject, htmlBody: html, name: 'Upset Special League' });
      sent++;
    } catch (e) { failed.push(addr); }
  });

  logEmailSend_(subject, sent, testOnly ? 'custom-test' : 'custom', payload.adminId);
  // The AI Results panel tags its real send with the week, so the admin's to-do strip
  // can show the recap as done. (This action is read-only for the router, so bust the
  // state cache here.)
  // Stored as "y<year>:<week>,<week>,…" in Season key recapSentWeeks (resets each
  // season; the "y" keeps Sheets from reading "2026:1" as a time).
  if (!testOnly && sent > 0 && payload.recapWeek !== undefined && payload.recapWeek !== '' && !isNaN(Number(payload.recapWeek))) {
    try {
      var cfg = getSeasonConfig();
      var year = 'y' + (cfg.year || new Date().getFullYear());
      var prev = String(cfg.recapSentWeeks || '').split(':');
      var weeks = prev[0] === year && prev[1] ? prev[1].split(',').map(Number) : [];
      if (weeks.indexOf(Number(payload.recapWeek)) < 0) weeks.push(Number(payload.recapWeek));
      setSeasonConfig('recapSentWeeks', year + ':' + weeks.sort(function(a, b) { return a - b; }).join(','));
      invalidateStateCache();
    } catch (e) { Logger.log('recapSentWeeks: ' + e.message); }
  }
  return { ok: true, sent: sent, failed: failed, testOnly: testOnly, quotaLeft: MailApp.getRemainingDailyQuota() };
}

// ── Default-PIN security email ─────────────────────────────────────────────────
// Every player imported from the old spreadsheet started with PIN 1234. This
// emails the ones still using it, with step-by-step instructions to change it.
//
// HOW TO USE (Apps Script editor):
//   previewDefaultPinEmail()  -- logs who would get it and emails ONE sample copy
//                                to the script owner. Sends nothing to players.
//   scheduleDefaultPinEmails() -- schedules the real send for next Tuesday 10 AM.
//   sendDefaultPinEmails()     -- the send itself (what the trigger runs). Only
//                                sends Tue-Thu, keeps a quota reserve, skips anyone
//                                already emailed in the last 6 days, and re-checks
//                                PINs at send time (people who already changed it
//                                are skipped automatically).
var DEFAULT_PIN = '1234';
var PIN_EMAIL_SEND_DAYS = [2, 3, 4];   // Tue, Wed, Thu -- no automated league emails go out these days
var PIN_EMAIL_QUOTA_RESERVE = 40;      // leave room for anything else that needs to send the same day

// The one PIN rule, used wherever a PIN is chosen. Returns an error message or ''.
//  - 4–6 digits
//  - must not start with 0: Google Sheets can turn "0123" into the number 123,
//    after which "0123" no longer matches at login and the player is locked out
//  - must not be the old league-wide default 1234
function pinProblem_(pin) {
  pin = String(pin == null ? '' : pin).trim();
  if (!/^\d{4,6}$/.test(pin)) return 'PIN must be 4–6 digits.';
  if (pin.charAt(0) === '0') return 'PIN can\'t start with 0 — please pick one that starts with 1–9.';
  if (pin === DEFAULT_PIN) return '1234 is the old league-wide default — please choose a different PIN.';
  return '';
}

function defaultPinPlayers_() {
  return sheetToObjects(SHEET_NAMES.PLAYERS).filter(function(p) {
    return (p.active === true || p.active === 'TRUE') &&
      String(p.pin).trim() === DEFAULT_PIN &&
      p.email && String(p.email).indexOf('@') > 0;
  });
}

function buildDefaultPinEmail_(player) {
  var first = String(player.name || '').trim().split(/\s+/)[0] || 'there';
  var team = escapeHtmlGs_(player.teamName || player.name || '');
  var step = function(n, html) {
    return '<tr><td style="vertical-align:top;padding:6px 12px 6px 0;"><span style="display:inline-block;width:26px;height:26px;border-radius:13px;background:#1a1a2e;color:#FFB800;font-weight:800;text-align:center;line-height:26px;font-size:13px;">' + n + '</span></td>' +
      '<td style="vertical-align:top;padding:8px 0;">' + html + '</td></tr>';
  };
  var body =
    '<p style="margin:0 0 16px;">Hi ' + escapeHtmlGs_(first) + ',</p>' +
    '<p style="margin:0 0 16px;">When the league moved into the app, every account started with the same PIN: <strong>1234</strong>. ' +
    'Your account (<strong>' + team + '</strong>) is still using it. Team names are listed on the standings page for everyone to see, ' +
    'so right now anyone in the league could log in as you.</p>' +
    '<div style="border-left:4px solid #FF6B35;background:#fff5f0;border-radius:0 8px 8px 0;padding:14px 16px;margin:18px 0;font-size:14px;line-height:1.7;">' +
      '<strong style="color:#b84a1a;text-transform:uppercase;font-size:12px;letter-spacing:0.08em;display:block;margin-bottom:6px;">Why it matters</strong>' +
      'Someone logged in as you could:' +
      '<ul style="margin:6px 0 0;padding-left:20px;">' +
        '<li>change your picks, including your Upset Special</li>' +
        '<li>change your Venmo / PayPal info, which is where your winnings get sent</li>' +
        '<li>post in the league chat under your name</li>' +
        '<li>change your PIN and lock you out of your own account</li>' +
      '</ul>' +
    '</div>' +
    '<p style="margin:22px 0 8px;font-weight:800;font-size:16px;">How to change it (about a minute)</p>' +
    '<table cellpadding="0" cellspacing="0" style="font-size:15px;line-height:1.5;">' +
      step(1, 'Open the app and log in with your team name <strong>' + team + '</strong> (or your name) and PIN <strong>1234</strong>.') +
      step(2, 'Tap <strong>Profile</strong> in the menu at the bottom of the screen.') +
      step(3, 'Scroll down to <strong>Change PIN</strong>.') +
      step(4, 'Enter <strong>1234</strong> as your Current PIN, then type a new <strong>4–6 digit</strong> PIN twice. It can\'t start with 0.') +
      step(5, 'Tap <strong>Update PIN</strong>. You\'ll see "PIN updated successfully."') +
    '</table>' +
    '<div style="text-align:center;margin:26px 0;">' +
      '<a href="' + EMAIL_APP_URL + '" style="display:inline-block;background:#1a1a2e;color:#FFB800;font-weight:800;text-decoration:none;padding:13px 28px;border-radius:8px;font-size:15px;">Open the App</a>' +
    '</div>' +
    '<p style="margin:0 0 10px;font-size:14px;color:#4a5068;"><strong>Pick something only you know.</strong> Skip easy ones like 1111 or 4321. PINs can\'t start with 0, and 1234 won\'t be accepted.</p>' +
    '<p style="margin:0 0 10px;font-size:14px;color:#4a5068;">Next time you log in, use your new PIN. If you ever forget it, just reply to this email and we\'ll reset it for you.</p>' +
    '<p style="margin:18px 0 0;">Thanks — and good luck this week.<br>— Upset Special League</p>';
  return {
    subject: '🔐 Action needed: change your Upset Special PIN',
    html: buildEmailHtml('Time to change your PIN', 'Your account is still using the league\'s default PIN, 1234.', body)
  };
}

function previewDefaultPinEmail() {
  var list = defaultPinPlayers_();
  Logger.log(list.length + ' active player(s) with PIN 1234 and an email on file: ' + list.map(function(p) { return p.teamName; }).join(', '));
  var noEmail = sheetToObjects(SHEET_NAMES.PLAYERS).filter(function(p) {
    return (p.active === true || p.active === 'TRUE') && String(p.pin).trim() === DEFAULT_PIN && !(p.email && String(p.email).indexOf('@') > 0);
  });
  if (noEmail.length) Logger.log('Still on 1234 but NO email on file (contact directly): ' + noEmail.map(function(p) { return p.teamName; }).join(', '));
  var me = Session.getEffectiveUser().getEmail();
  var sample = buildDefaultPinEmail_(list[0] || { name: 'Sample Player', teamName: 'SAMPLETEAM' });
  MailApp.sendEmail({ to: me, subject: '[PREVIEW] ' + sample.subject, htmlBody: sample.html, name: 'Upset Special League' });
  Logger.log('Sample copy sent to ' + me + '. Remaining email quota today: ' + MailApp.getRemainingDailyQuota());
}

function scheduleDefaultPinEmails() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'sendDefaultPinEmails') ScriptApp.deleteTrigger(t);
  });
  var when = new Date();
  when.setDate(when.getDate() + ((2 - when.getDay() + 7) % 7 || 7)); // next Tuesday
  when.setHours(10, 0, 0, 0);
  ScriptApp.newTrigger('sendDefaultPinEmails').timeBased().at(when).create();
  Logger.log('PIN emails scheduled for ' + when.toString() + ' (' + defaultPinPlayers_().length + ' player(s) currently qualify).');
}

function sendDefaultPinEmails() {
  var day = Number(Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/New_York', 'u')) % 7; // 1=Mon..7=Sun -> 0=Sun
  if (PIN_EMAIL_SEND_DAYS.indexOf(day) < 0) {
    Logger.log('Not a PIN-email day (Tue-Thu only, to stay clear of weekend pick-reminder emails). Nothing sent.');
    return { sent: 0, skipped: 'day' };
  }
  var props = PropertiesService.getScriptProperties();
  var recent = JSON.parse(props.getProperty('pinEmailSentAt') || '{}');
  var list = defaultPinPlayers_().filter(function(p) {
    return !recent[p.id] || Date.now() - new Date(recent[p.id]).getTime() > 6 * 86400000;
  });
  if (list.length === 0) { Logger.log('Nobody left on the default PIN (or all were emailed this week). Nothing sent.'); return { sent: 0 }; }
  var quota = MailApp.getRemainingDailyQuota();
  if (quota - list.length < PIN_EMAIL_QUOTA_RESERVE) {
    Logger.log('Email quota too low today (' + quota + ' left, need ' + list.length + ' + ' + PIN_EMAIL_QUOTA_RESERVE + ' reserve). Nothing sent — run again tomorrow.');
    return { sent: 0, skipped: 'quota' };
  }
  var sent = 0, failed = [];
  list.forEach(function(p) {
    try {
      var msg = buildDefaultPinEmail_(p);
      MailApp.sendEmail({ to: String(p.email).trim(), subject: msg.subject, htmlBody: msg.html, name: 'Upset Special League' });
      recent[p.id] = new Date().toISOString();
      sent++;
    } catch (e) { failed.push(p.teamName); Logger.log('PIN email failed for ' + p.teamName + ': ' + e.message); }
  });
  props.setProperty('pinEmailSentAt', JSON.stringify(recent));
  logEmailSend_('🔐 Action needed: change your Upset Special PIN', sent, 'pin-reminder', 'system');
  Logger.log('PIN emails sent: ' + sent + (failed.length ? ' | failed: ' + failed.join(', ') : '') + ' | quota left: ' + MailApp.getRemainingDailyQuota());
  return { sent: sent, failed: failed };
}

// Preview the wrapped HTML without sending.
function apiAdminPreviewCustomEmail(payload) {
  requireAdmin(payload);
  return {
    ok: true,
    html: buildEmailHtml(
      String(payload.title || 'Headline'),
      String(payload.subtitle || ''),
      String(payload.bodyHtml || '<p>Body goes here.</p>')
    )
  };
}


// ── AI Weekly Results Email ───────────────────────────────────────────────────
// Gathers the week's real data, hands it to Claude, gets back an HTML body.

function buildWeekRecap_(week) {
  week = Number(week);
  var season   = getSeasonConfig();
  var year     = Number(season.year || new Date().getFullYear());
  var games    = sheetToObjects(SHEET_NAMES.GAMES).filter(function(g) {
    return Number(g.week) === week && g.source !== 'external';
  });
  // Upset Special picks can legitimately reference an external game (picked via
  // "Search Any Game", not one of the 10 board games) -- this broader lookup
  // covers both, so an external-game upset hit isn't silently missed just
  // because the game isn't part of the board.
  var allGamesThisWeek = sheetToObjects(SHEET_NAMES.GAMES).filter(function(g) {
    return Number(g.week) === week;
  });
  var picks    = sheetToObjects(SHEET_NAMES.PICKS).filter(function(p) { return Number(p.week) === week; });
  var players  = sheetToObjects(SHEET_NAMES.PLAYERS).filter(function(p) { return p.active; });

  var nameById = {};
  players.forEach(function(p) { nameById[p.id] = p.teamName || p.name; });

  // Game results + upset flags
  var gameLines = [];
  var gameResults = [];
  games.forEach(function(g) {
    var a = Number(g.finalAwayScore) || 0, h = Number(g.finalHomeScore) || 0;
    var final = (g.isFinal === true || g.isFinal === 'TRUE');
    if (!final) { gameLines.push(g.awayTeam + ' at ' + g.homeTeam + ' — not final'); return; }
    var winner = a > h ? g.awayTeam : g.homeTeam;
    var dog = (g.favorite === g.homeTeam) ? g.awayTeam : g.homeTeam;
    var upset = (winner === dog) ? ' [UPSET]' : '';
    gameLines.push(g.awayTeam + ' ' + a + ' at ' + g.homeTeam + ' ' + h +
           ' (fav: ' + g.favorite + ' by ' + (g.spread || '?') + ')' + upset);

    // Structured version for validation: who actually covered this game.
    var favMargin = (g.favorite === g.homeTeam) ? (h - a) : (a - h);
    var coveringTeam = favMargin > Number(g.spread) ? g.favorite : dog;
    gameResults.push({
      awayTeam: g.awayTeam, homeTeam: g.homeTeam, awayScore: a, homeScore: h,
      favorite: g.favorite, dog: dog, spread: Number(g.spread) || 0,
      winner: winner, coveringTeam: coveringTeam
    });
  });

  // Per-player week performance
  var perf = [];
  players.forEach(function(pl) {
    var mine = picks.filter(function(pk) { return pk.playerId === pl.id; });
    if (mine.length === 0) return;
    var correct = 0, total = 0, upsetHit = null, upsetMiss = null, upsetPts = 0;
    mine.forEach(function(pk) {
      var g = allGamesThisWeek.find(function(gg) { return gg.gameId === pk.gameId; });
      if (!g || !(g.isFinal === true || g.isFinal === 'TRUE')) return;
      var a = Number(g.finalAwayScore) || 0, h = Number(g.finalHomeScore) || 0;
      var winner = a > h ? g.awayTeam : g.homeTeam;
      var isUpsetPick = (pk.isUpset === true || pk.isUpset === 'TRUE');
      if (isUpsetPick) {
        var dog = (g.favorite === g.homeTeam) ? g.awayTeam : g.homeTeam;
        if (String(pk.pickedTeam) === dog && winner === dog) {
          upsetHit = pk.pickedTeam + ' +' + (g.spread || 0);
          upsetPts = Number(g.spread) || 0;
        } else {
          upsetMiss = String(pk.pickedTeam);
        }
      } else {
        total++;
        if (String(pk.pickedTeam) === computeCoveringTeam_(g)) correct++;
      }
    });
    perf.push({
      team: nameById[pl.id] || pl.teamName,
      correct: correct,
      total: total,
      perfect: (total > 0 && correct === total),
      upsetHit: upsetHit,
      upsetMiss: upsetMiss,
      weekPts: correct + upsetPts
    });
  });
  perf.sort(function(a, b) { return b.weekPts - a.weekPts; });

  return {
    week: week,
    year: year,
    gameLines: gameLines,
    gameResults: gameResults,
    performances: perf,
    upsetHitters: perf.filter(function(p) { return p.upsetHit; }),
    perfectWeeks: perf.filter(function(p) { return p.perfect; })
  };
}

function apiAdminGenerateResultsEmail(payload) {
  requireAdmin(payload);
  if (payload.week === undefined || payload.week === null || payload.week === '') {
    return { ok: false, error: 'Missing week.' };
  }
  var week = Number(payload.week);
  if (isNaN(week)) return { ok: false, error: 'Invalid week.' };

  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) return { ok: false, error: 'ANTHROPIC_API_KEY not set in Script Properties.' };

  var recap = buildWeekRecap_(week);
  if (recap.performances.length === 0) {
    return { ok: false, error: 'No completed picks found for Week ' + week + '. Post results first.' };
  }

  var top = recap.performances.slice(0, 12).map(function(p) {
    return '- ' + p.team + ': ' + p.correct + '/' + p.total + ' straight, ' +
           (p.upsetHit ? 'UPSET HIT ' + p.upsetHit : (p.upsetMiss ? 'upset miss (' + p.upsetMiss + ')' : 'no upset')) +
           ', ' + p.weekPts + ' pts';
  }).join('\n');

  var dataBlock =
    'WEEK ' + recap.week + ' — ' + recap.year + '\n\n' +
    'GAME RESULTS:\n' + recap.gameLines.join('\n') + '\n\n' +
    'PLAYER PERFORMANCE (top 12 by week points):\n' + top + '\n\n' +
    'UPSET SPECIALS HIT: ' + (recap.upsetHitters.length
      ? recap.upsetHitters.map(function(p) { return p.team + ' (' + p.upsetHit + ')'; }).join(', ')
      : 'NONE — nobody hit their upset this week') + '\n' +
    'UPSET SPECIALS BY TEAM (number of winners, then who): ' + (function() {
      var groups = {};
      recap.upsetHitters.forEach(function(p) { (groups[p.upsetHit] = groups[p.upsetHit] || []).push(p.team); });
      var keys = Object.keys(groups).sort(function(a, b) { return groups[b].length - groups[a].length; });
      return keys.length ? keys.map(function(k) { return k + ' — ' + groups[k].length + ': ' + groups[k].join(', '); }).join('; ') : 'none';
    })() + '\n' +
    'PERFECT WEEKS (' + recap.gameLines.length + '/' + recap.gameLines.length + '): ' + (recap.perfectWeeks.length
      ? recap.perfectWeeks.map(function(p) { return p.team; }).join(', ')
      : 'none') + '\n';

  var system =
    'You write the weekly results recap email for the Upset Special fantasy college football league. ' +
    'Voice: sharp, funny, a little mean in a locker-room way. You know these guys. Celebrate the winners, ' +
    'roast the blowups affectionately, and make the near-misses hurt a little.\n\n' +
    'ACCURACY IS THE #1 PRIORITY -- more important than being entertaining. This is a real-money league and ' +
    'players will check every claim against the data. Follow these rules exactly:\n' +
    '- Never invent a stat, score, margin, or outcome. Every number and every game result you state must come ' +
    'directly from the data below.\n' +
    '- Never say a team "won outright" or "won" unless GAME RESULTS explicitly shows them as the higher score.\n' +
    '- Before ever saying a favorite "covered" (in any section, including general commentary on non-upset games), ' +
    'compute their actual winning margin from the score and compare it to their spread number. They only covered if ' +
    'their margin is GREATER than the spread. A team that wins by less than their spread did NOT cover -- the underdog did, ' +
    'even though the favorite still won the game. Do not describe a favorite as covering a spread near their own margin ' +
    '("barely covered") without first checking whether that margin is actually above or below the spread number.\n' +
    '- An Upset Special only "hits" for a player if they appear in the UPSET SPECIALS HIT list below. If a ' +
    'player is not in that list, their upset pick missed -- even if the team covered the spread or played well. ' +
    'Covering is not the same as winning outright.\n' +
    '- When you state a player\'s point total, it must exactly match the number in PLAYER PERFORMANCE. Always ' +
    'write points and scores as numerals (19, not "nineteen") so they can be verified.\n' +
    '- The number of games in a week VARIES (it is not always 10) -- read the actual count from the data.\n' +
    '- When you group Upset Special winners by the team they picked, copy the groups exactly from UPSET SPECIALS BY TEAM. ' +
    'Never put a player in a group they are not listed in. Only call a pick "the most popular" if it has strictly more winners than every other pick.\n' +
    '- If you state a margin of victory, compute it from the final score (winner minus loser).\n' +
    '- Before finalizing, re-check every score, margin, and point total you wrote against the data above.\n\n' +
    'OUTPUT: raw HTML fragment only. No <html>, <head>, <body>, or <style> tags. No markdown, no code fences.\n\n' +
    'Use exactly these inline-styled building blocks:\n' +
    '<p style="margin-bottom:16px;">paragraph</p>\n' +
    '<div style="font-size:11px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:#8c6a2a;margin:22px 0 10px;">SECTION LABEL</div>\n' +
    '<div style="border-left:4px solid #F2B632;background:#fffbf2;border-radius:0 8px 8px 0;padding:14px 16px;margin:18px 0;"><p style="margin:0;font-size:14px;color:#3a2a00;line-height:1.6;">callout text</p></div>\n' +
    '<ul style="list-style:none;margin:14px 0;padding:0;"><li style="padding:5px 0 5px 20px;position:relative;font-size:14px;">&rarr; item</li></ul>\n' +
    '<hr style="border:none;border-top:1px solid #ebe5d8;margin:22px 0;">\n\n' +
    'STRUCTURE: open with the headline story of the week, then a Winners section, then an Upset Special ' +
    'section, then a Notable Performances or Bad Beats section, then a short forward-looking close. ' +
    '350-500 words. Bold team names with <strong>.';

  var bodyHtml = '', lastErrors = [], verified = false;
  var maxAttempts = 3, attemptIssues = [];
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    var userMsg = 'Write the Week ' + recap.week + ' recap.\n\n' + dataBlock;
    if (lastErrors.length) {
      userMsg += '\n\nYour previous attempt had these factual errors -- fix them:\n' + lastErrors.map(function(e) { return '- ' + e; }).join('\n');
    }
    try {
      var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        payload: JSON.stringify({
          model: 'claude-sonnet-4-6',
          // A 350-500 word recap in inline-styled HTML runs ~1,500-3,000 tokens; the old
          // 2,000 cap cut Week 4's recap off mid-tag. The cap is only a ceiling -- the
          // model still stops when the recap is done.
          max_tokens: 8000,
          system: system,
          messages: [{ role: 'user', content: userMsg }]
        }),
        muteHttpExceptions: true
      });
      var code = resp.getResponseCode();
      if (code !== 200) return { ok: false, error: 'Anthropic API error ' + code + ': ' + resp.getContentText().slice(0, 300) };
      var data = JSON.parse(resp.getContentText());
      bodyHtml = (data.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');
      if (!bodyHtml) return { ok: false, error: 'Empty response from Claude' + (data.stop_reason ? ' (stop_reason: ' + data.stop_reason + ')' : '') + '.' };
      bodyHtml = bodyHtml.replace(/```html/g, '').replace(/```/g, '').trim();
    } catch (e) {
      return { ok: false, error: 'Generation failed: ' + e.message };
    }
    lastErrors = validateRecapAccuracy_(bodyHtml, recap);
    // The API marks a reply that hit the length cap with stop_reason "max_tokens" --
    // that recap is incomplete no matter what the content checks say.
    if (data.stop_reason === 'max_tokens') {
      lastErrors.unshift('Your previous recap was cut off before it finished. Write a complete recap within the 350-500 word target.');
    }
    attemptIssues.push(lastErrors.slice());
    if (lastErrors.length === 0) { verified = true; break; }
    Logger.log('Recap validation attempt ' + attempt + ' found issues: ' + lastErrors.join(' | '));
  }
  logRecapCheck_(week, verified, attemptIssues);

  // Never let a cut-off tag swallow the box score appended below it
  bodyHtml = bodyHtml.replace(/<[^>]*$/, '');

  var headline = 'Week ' + recap.week + ' Results';
  var sub = recap.upsetHitters.length
    ? recap.upsetHitters.length + ' upset special' + (recap.upsetHitters.length === 1 ? '' : 's') + ' cashed.'
    : 'Nobody hit their upset. Brutal week.';

  // Deterministic, never-AI-generated box score -- this is the guaranteed-accurate
  // reference appended below the narrative, since the AI's prose is never the
  // source of truth for a real-money league, however well the automated check
  // above performs.
  var boxScoreHtml = buildOfficialBoxScoreHtml_(recap);

  var draft = {
    ok: true,
    week: recap.week,
    title: headline,
    subtitle: sub,
    bodyHtml: bodyHtml + boxScoreHtml,
    verified: verified,
    validationIssues: lastErrors,
    attempts: attemptIssues.length,
    generatedAt: new Date().toISOString(),
    stats: {
      games: recap.gameLines.length,
      players: recap.performances.length,
      upsetHits: recap.upsetHitters.length,
      perfectWeeks: recap.perfectWeeks.length
    }
  };
  // Keep the draft server-side: a run takes 30-100s, and Google often loses replies
  // that slow -- without this the admin lost the draft (and 3 AI calls) and started over.
  saveResultsDraft_(draft);
  draft.html = buildEmailHtml(headline, sub, bodyHtml + boxScoreHtml);
  return draft;
}

var RESULTS_DRAFT_TTL = 21600; // 6h, CacheService's maximum

function resultsDraftKey_(week) { return 'resultsDraft_' + Number(week); }

function saveResultsDraft_(draft) {
  try { cachePutChunked_(CacheService.getScriptCache(), resultsDraftKey_(draft.week), JSON.stringify(draft), RESULTS_DRAFT_TTL); }
  catch (e) { Logger.log('results draft save: ' + e.message); }
}

// The last generated recap for a week (up to 6h old), so a lost reply or closed tab
// doesn't cost a new generation. Read-only.
function apiAdminGetResultsDraft(payload) {
  requireAdmin(payload);
  var raw = null;
  try { raw = cacheGetChunked_(CacheService.getScriptCache(), resultsDraftKey_(payload.week)); } catch (e) {}
  if (!raw) return { ok: true, draft: null };
  var draft = JSON.parse(raw);
  draft.html = buildEmailHtml(draft.title, draft.subtitle, draft.bodyHtml);
  return { ok: true, draft: draft };
}

// One PerfLog row per recap run (`recapCheck`): ok = passed the accuracy check, error =
// the first attempt's issues (shows up as topError in diagnostics), notes = every
// attempt's issues. Shows which check keeps failing, so the prompt or the check can
// be fixed and most runs need one AI call instead of three.
function logRecapCheck_(week, verified, attemptIssues) {
  try {
    var ss = getSS();
    var sheet = ss.getSheetByName('PerfLog');
    if (!sheet) {
      sheet = ss.insertSheet('PerfLog');
      sheet.appendRow(['timestamp', 'action', 'ms', 'ok', 'error', 'reason', 'notes']);
      sheet.setFrozenRows(1);
    }
    var first = (attemptIssues[0] || []).join(' | ');
    sheet.appendRow([
      new Date().toISOString(), 'recapCheck', attemptIssues.length, verified,
      verified && attemptIssues.length === 1 ? '' : String(first || 'passed on retry').slice(0, 200),
      'recap', JSON.stringify({ week: week, attempts: attemptIssues }).slice(0, 1000)
    ]);
  } catch (e) { /* logging must never break the recap */ }
}

// Checks the AI-generated narrative against the ground-truth recap data.
// Returns an array of specific, human-readable issues (empty if none found).
// Deliberately conservative: only flags things it can check with certainty,
// so a clean result here is a meaningful accuracy signal, not just "looks fine".
// Exact-match only -- for player fantasy team names, which have no "mascot"
// to drop and must never be prefix-matched (a name like "THE BRYCE AGE" would
// otherwise degrade to matching the word "the" everywhere in the text).
function findExactMentions_(textLower, name) {
  var nameLower = String(name).toLowerCase();
  var indices = [], searchFrom = 0;
  while (true) {
    var idx = textLower.indexOf(nameLower, searchFrom);
    if (idx === -1) break;
    indices.push({ start: idx, len: nameLower.length });
    searchFrom = idx + 1;
  }
  return indices;
}

// AI-written prose almost always drops the mascot ("Notre Dame" not "Notre
// Dame Fighting Irish"), so matching against the exact full team name misses
// most real mentions. Use this ONLY for actual school/mascot names (never for
// player fantasy team names -- see findExactMentions_ for those). Tries the
// full name first, then progressively shorter prefixes (dropping one trailing
// word at a time) until one is found in the text.
function findTeamMentions_(textLower, fullTeamName) {
  var words = String(fullTeamName).toLowerCase().split(' ');
  for (var dropCount = 0; dropCount < words.length; dropCount++) {
    var candidate = words.slice(0, words.length - dropCount).join(' ');
    if (!candidate) continue;
    var indices = [], searchFrom = 0;
    while (true) {
      var idx = textLower.indexOf(candidate, searchFrom);
      if (idx === -1) break;
      indices.push({ start: idx, len: candidate.length });
      searchFrom = idx + 1;
    }
    if (indices.length > 0) return indices;
  }
  return [];
}

// ---- recap checker helpers -------------------------------------------------
// Plain text with block boundaries preserved as newlines (so a list item or
// paragraph never bleeds into the next one), split into sentences. Claims are
// always checked WITHIN the sentence they appear in -- the old fixed 60-150
// character windows attributed one player's "17 pts" to the next player named.
function recapSentences_(html) {
  var text = String(html)
    .replace(/<\/(p|div|li|ul|ol|h\d)>|<br\s*\/?>|<hr[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&rarr;/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ');
  var out = [];
  text.split(/\n+/).forEach(function(block) {
    block.split(/(?<=[.!?])\s+(?=[A-Z"'(])/).forEach(function(s) {
      s = s.replace(/\s+/g, ' ').trim();
      if (s) out.push({ text: s, lower: s.toLowerCase() });
    });
  });
  return out;
}

function reEscape_(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Whole-word, case-insensitive occurrences of `needle` in `lower` (already lowercased).
function wordHits_(lower, needle) {
  var re = new RegExp('(?<![a-z0-9])' + reEscape_(String(needle).toLowerCase()) + '(?![a-z0-9])', 'g');
  var hits = [], m;
  while ((m = re.exec(lower))) { hits.push({ start: m.index, end: m.index + m[0].length }); }
  return hits;
}

// Maps every way prose refers to a college team ("Alabama", "Crimson Tide",
// "Alabama Crimson Tide") to that team. An alias shared by two teams goes to the
// one it describes most completely ("Texas" -> Longhorns, not Texas A&M;
// "Michigan" -> Wolverines, not Michigan State); a true tie ("Tigers" for Auburn
// and LSU) is dropped rather than guessed.
function buildTeamAliases_(teamNames) {
  var byAlias = {};
  teamNames.forEach(function(full) {
    var words = String(full).toLowerCase().split(/\s+/).filter(Boolean);
    var add = function(alias, leftover) {
      if (!alias || alias.length < 3) return;
      (byAlias[alias] = byAlias[alias] || []).push({ team: full, leftover: leftover });
    };
    for (var n = words.length; n >= 1; n--) add(words.slice(0, n).join(' '), words.length - n); // school prefixes
    if (words.length >= 2) add(words[words.length - 1], words.length - 1);                          // mascot
    if (words.length >= 3) add(words.slice(-2).join(' '), words.length - 2);                        // two-word mascot
  });
  var aliases = [];
  Object.keys(byAlias).forEach(function(alias) {
    var cands = byAlias[alias].slice().sort(function(a, b) { return a.leftover - b.leftover; });
    var uniqueTeams = cands.filter(function(c, i) { return cands.findIndex(function(x) { return x.team === c.team; }) === i; });
    if (uniqueTeams.length > 1 && uniqueTeams[0].leftover === uniqueTeams[1].leftover) return; // genuine tie
    aliases.push({ alias: alias, team: uniqueTeams[0].team });
  });
  return aliases.sort(function(a, b) { return b.alias.length - a.alias.length; });
}

// Team mentions in one sentence, longest alias first, no overlaps.
function teamMentionsIn_(lower, aliases) {
  var taken = [], out = [];
  aliases.forEach(function(a) {
    wordHits_(lower, a.alias).forEach(function(h) {
      if (taken.some(function(t) { return h.start < t.end && t.start < h.end; })) return;
      taken.push(h);
      out.push({ team: a.team, start: h.start, end: h.end });
    });
  });
  return out.sort(function(a, b) { return a.start - b.start; });
}

var RECAP_NEGATION_ = /(\bnot\b|\bnever\b|\bfail(ed|s)?\b|\bfell\b|\bshort\b|n't|n’t|\bno\b)/;

function validateRecapAccuracy_(bodyHtml, recap) {
  var errors = [];
  var text = bodyHtml.replace(/<[^>]+>/g, ' '); // strip HTML tags so name/number matching isn't broken by markup
  var textLower = text.toLowerCase();
  var sentences = recapSentences_(bodyHtml);

  // 0. Cut-off / broken HTML (the AI hit its length limit mid-tag, or left blocks unclosed)
  var html = String(bodyHtml);
  if (html.lastIndexOf('<') > html.lastIndexOf('>')) {
    errors.push('The recap is cut off mid-HTML-tag at the end -- it is incomplete.');
  } else {
    ['div', 'p', 'ul', 'li'].forEach(function(tag) {
      var opens = (html.match(new RegExp('<' + tag + '(\\s|>)', 'gi')) || []).length;
      var closes = (html.match(new RegExp('</' + tag + '>', 'gi')) || []).length;
      if (opens !== closes) errors.push('The recap HTML is broken: ' + opens + ' <' + tag + '> tags opened but ' + closes + ' closed.');
    });
  }

  // Player names, longest first so e.g. a short name inside a longer one isn't double-counted
  var players = recap.performances.slice().sort(function(a, b) { return String(b.team).length - String(a.team).length; });
  function playerMentionsIn_(lower) {
    var taken = [], out = [];
    players.forEach(function(p) {
      wordHits_(lower, p.team).forEach(function(h) {
        if (taken.some(function(t) { return h.start < t.end && t.start < h.end; })) return;
        taken.push(h);
        out.push({ p: p, start: h.start, end: h.end });
      });
    });
    return out.sort(function(a, b) { return a.start - b.start; });
  }

  // Upset Special winners grouped by the team they hit ("Minnesota Golden Gophers" -> [players])
  var hitTeamOf = {}, hittersByTeam = {};
  (recap.upsetHitters || []).forEach(function(p) {
    var t = String(p.upsetHit).replace(/\s*\+[\d.]+\s*$/, '');
    hitTeamOf[p.team] = t;
    (hittersByTeam[t] = hittersByTeam[t] || []).push(p.team);
  });
  var allTeams = [];
  (recap.gameResults || []).forEach(function(g) { allTeams.push(g.awayTeam, g.homeTeam); });
  Object.keys(hittersByTeam).forEach(function(t) { if (allTeams.indexOf(t) < 0) allTeams.push(t); });
  var aliases = buildTeamAliases_(allTeams);
  var gameOf = {};
  (recap.gameResults || []).forEach(function(g) { gameOf[g.awayTeam] = g; gameOf[g.homeTeam] = g; });

  sentences.forEach(function(s) {
    var pm = playerMentionsIn_(s.lower);
    var tm = teamMentionsIn_(s.lower, aliases);

    // 1. "N pts" belongs to the nearest player named BEFORE it in the same sentence
    var ptsRe = /(\d+(?:\.\d+)?)\s*(?:pts|points)\b/g, m;
    while ((m = ptsRe.exec(s.lower))) {
      if (/\bby\s*$/.test(s.lower.slice(Math.max(0, m.index - 4), m.index))) continue; // "won by 3 points" is a margin, not a total
      var owner = null;
      pm.forEach(function(x) { if (x.end <= m.index) owner = x; });
      if (!owner) continue;
      if (Number(m[1]) !== Number(owner.p.weekPts)) {
        errors.push(owner.p.team + ' is credited with ' + m[1] + ' pts, but their actual total this week is ' + owner.p.weekPts + ' pts.');
      }
    }

    // 2. A sentence about ONE upset team must only name players who hit THAT team
    var hitTeamsHere = tm.map(function(x) { return x.team; })
      .filter(function(t, i, arr) { return hittersByTeam[t] && arr.indexOf(t) === i; });
    if (hitTeamsHere.length === 1) {
      pm.forEach(function(x) {
        var actual = hitTeamOf[x.p.team];
        if (actual && actual !== hitTeamsHere[0]) {
          errors.push(x.p.team + ' is grouped with the ' + hitTeamsHere[0] + ' Upset Special winners, but their Upset Special was actually ' + x.p.upsetHit + '.');
        }
      });
    }

    // 3. "most popular" must point at the team with the uniquely most winners
    if (/most (popular|picked|common)|most-picked/.test(s.lower) && hitTeamsHere.length) {
      var counts = Object.keys(hittersByTeam).map(function(t) { return hittersByTeam[t].length; });
      var max = Math.max.apply(null, counts);
      var leaders = Object.keys(hittersByTeam).filter(function(t) { return hittersByTeam[t].length === max; });
      var claimed = hitTeamsHere[0];
      if (hittersByTeam[claimed].length < max || leaders.length > 1) {
        errors.push('The text calls ' + claimed + ' the most popular Upset Special, but ' +
          (leaders.length > 1 ? leaders.join(', ') + ' are tied at ' + max + ' winners each.' : leaders[0] + ' had the most winners (' + max + ').'));
      }
    }

    // 4. Stated margins must match the final score (only when the sentence is about one game)
    var gamesHere = tm.map(function(x) { return gameOf[x.team]; }).filter(function(g, i, arr) { return g && arr.indexOf(g) === i; });
    if (gamesHere.length === 1) {
      var g = gamesHere[0], margin = Math.abs(g.awayScore - g.homeScore);
      var marginRe = /(\d+(?:\.\d+)?)[-\s]point (margin|win|victory|blowout|loss|beatdown)|\bwon by (\d+(?:\.\d+)?)\b/g, mm;
      while ((mm = marginRe.exec(s.lower))) {
        var n = Number(mm[1] || mm[3]);
        if (n !== margin) errors.push('The text gives the ' + g.awayTeam + ' at ' + g.homeTeam + ' margin as ' + n + ', but the final score (' + g.awayScore + '-' + g.homeScore + ') is a ' + margin + '-point margin.');
      }
    }

    // 5. "covered": the team named right before the word must be the one that actually covered
    var coverRe = /\bcover(ed|s|ing)?\b/g, cm;
    while ((cm = coverRe.exec(s.lower))) {
      var subj = null;
      tm.forEach(function(x) { if (x.end <= cm.index) subj = x; });
      if (!subj || !gameOf[subj.team]) continue;
      var gg = gameOf[subj.team];
      var between = s.lower.slice(subj.end, cm.index);
      if (RECAP_NEGATION_.test(between)) continue; // "Michigan ... failed to cover" is a correct negative claim
      if (subj.team !== gg.coveringTeam) {
        errors.push('The text says ' + subj.team + ' covered, but ' + gg.coveringTeam + ' is the team that covered (' + gg.awayTeam + ' ' + gg.awayScore + ', ' + gg.homeTeam + ' ' + gg.homeScore + ', ' + gg.favorite + ' favored by ' + gg.spread + ').');
      }
    }
  });

  // Every player who actually hit their upset must be named in the recap somewhere.
  recap.upsetHitters.forEach(function(p) {
    if (findExactMentions_(textLower, p.team).length === 0) { // exact match -- player name
      errors.push(p.team + ' hit their Upset Special (' + p.upsetHit + ') but is not mentioned anywhere in the recap.');
    }
  });

  // A player who MISSED their upset should not be described with hit-language
  // right next to their missed pick's team name (catches the exact class of
  // error seen before: claiming a missed upset team "won outright").
  recap.performances.forEach(function(p) {
    if (!p.upsetMiss) return;
    var playerMentions = findExactMentions_(textLower, p.team); // exact match -- player name
    var teamMentions = findTeamMentions_(textLower, p.upsetMiss); // prefix match -- school name
    if (playerMentions.length === 0 || teamMentions.length === 0) return;
    var flagged = teamMentions.some(function(m) {
      var windowText = textLower.slice(Math.max(0, m.start - 100), m.start + m.len + 100);
      return windowText.indexOf('won outright') !== -1 || windowText.indexOf('won the game') !== -1;
    });
    if (flagged) {
      errors.push(p.team + '\'s upset pick (' + p.upsetMiss + ') actually MISSED, but the text near that team name suggests it won outright -- double check this claim.');
    }
  });

  // de-duplicate (the same wrong claim can appear in both the prose and a list)
  return errors.filter(function(e, i) { return errors.indexOf(e) === i; });
}

// Builds a plain, deterministic box score table straight from recap data --
// no AI involved at any point, so this is always exactly correct regardless
// of how the narrative above it turned out. This is the section a player
// should check first if they ever doubt a claim in the write-up.
function buildOfficialBoxScoreHtml_(recap) {
  var gamesRows = recap.gameLines.map(function(line) {
    return '<div style="padding:6px 0;border-bottom:1px solid #ebe5d8;font-size:13px;color:#3a2a00;">' + escapeHtmlGas_(line) + '</div>';
  }).join('');
  var playerRows = recap.performances.map(function(p) {
    var upsetText = p.upsetHit ? ('HIT ' + p.upsetHit) : (p.upsetMiss ? ('missed (' + p.upsetMiss + ')') : 'no upset');
    return '<div style="padding:6px 0;border-bottom:1px solid #ebe5d8;font-size:13px;color:#3a2a00;">' +
      '<strong>' + escapeHtmlGas_(p.team) + '</strong> — ' + p.correct + '/' + p.total + ' straight, ' + escapeHtmlGas_(upsetText) + ', <strong>' + p.weekPts + ' pts</strong>' +
      '</div>';
  }).join('');
  return '<hr style="border:none;border-top:1px solid #ebe5d8;margin:22px 0;">' +
    '<div style="font-size:11px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:#8c6a2a;margin:22px 0 10px;">Official Box Score</div>' +
    '<p style="margin:0 0 10px;font-size:12px;color:#6e7892;">Generated directly from the results data -- this section is always accurate, independent of the recap above.</p>' +
    '<div style="margin-bottom:16px;">' + gamesRows + '</div>' +
    '<div>' + playerRows + '</div>';
}

function escapeHtmlGas_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// =================================================================
// PERFORMANCE LOGGING + AUTOMATED DIAGNOSTICS
// =================================================================
//
// SETUP (once, from the Apps Script editor): select installDiagnosticsTrigger -> Run.
// That schedules runDiagnostics() nightly (~4am script time). You can also run
// runDiagnostics() by hand any time. Results land in two sheet tabs:
//   DiagnosticsReport -- the latest full report (overwritten each run)
//   DiagnosticsHistory -- one summary row per run, to see trends over time
// If anything is flagged as a WARNING, the report is also emailed to the script
// owner (or to the address in Script Property DIAG_EMAIL, if set).
//
// PerfLog tab: handle() records every request slower than PERF_SLOW_MS, every
// failed request, and a PERF_SAMPLE_RATE random sample of the rest -- enough to
// compute p50/p95 per feature without writing a row on every call.

var PERF_SLOW_MS = 4000;
var PERF_SAMPLE_RATE = 0.05;
var PERF_LOG_KEEP_DAYS = 30;
var _perfNotes = {};

// Attach a detail to the current request's perf record (e.g. cache hit/miss,
// ESPN failures). Numbers accumulate; anything else overwrites.
function perfNote_(key, val) {
  if (typeof val === 'number') _perfNotes[key] = (_perfNotes[key] || 0) + val;
  else _perfNotes[key] = val;
}

function logPerf_(action, ms, result) {
  try {
    var failed = !result || result.ok === false;
    var slow = ms >= PERF_SLOW_MS;
    if (!failed && !slow && Math.random() >= PERF_SAMPLE_RATE) return;
    // When the backend is overloaded nearly every request is "slow", and a sheet
    // write per request makes the spreadsheet slower still. Record at most one
    // slow/sample row per 20s; failures are always recorded.
    if (!failed) {
      var c = CacheService.getScriptCache();
      if (c.get('perfLogRecent')) return;
      c.put('perfLogRecent', '1', 20);
    }
    var ss = getSS();
    var sheet = ss.getSheetByName('PerfLog');
    if (!sheet) {
      sheet = ss.insertSheet('PerfLog');
      sheet.appendRow(['timestamp', 'action', 'ms', 'ok', 'error', 'reason', 'notes']);
      sheet.setFrozenRows(1);
    }
    sheet.appendRow([
      new Date().toISOString(), action || '(none)', ms, !failed,
      failed ? String((result && result.error) || '').slice(0, 200) : '',
      failed ? 'error' : (slow ? 'slow' : 'sample'),
      Object.keys(_perfNotes).length ? JSON.stringify(_perfNotes).slice(0, 300) : ''
    ]);
  } catch (e) { /* perf logging must never break a request */ }
}

// Failures the SERVER never sees: a save that timed out or hit Google's error page
// on the player's phone, or a submit the app blocked before sending. The frontend
// reports them here so they land in PerfLog as `client:<action>` rows -- this is
// the evidence that was missing when a player said "it wouldn't let me change my pick".
function apiLogClientError(payload) {
  try {
    var sheet = getSS().getSheetByName('PerfLog');
    if (!sheet) return { ok: true };
    var player = sheetToObjects(SHEET_NAMES.PLAYERS).find(function(p) { return p.id === payload.playerId; });
    sheet.appendRow([
      new Date().toISOString(),
      'client:' + String(payload.failedAction || 'unknown').slice(0, 40),
      Number(payload.ms) || '',
      false,
      String(payload.message || '').slice(0, 200),
      'client',
      JSON.stringify({ team: player ? player.teamName : '', at: String(payload.at || '').slice(0, 30), view: String(payload.view || '').slice(0, 20), detail: String(payload.detail || '').slice(0, 150) })
    ]);
  } catch (e) {}
  return { ok: true };
}

function installDiagnosticsTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'runDiagnostics') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runDiagnostics').timeBased().everyDays(1).atHour(4).create();
  Logger.log('runDiagnostics trigger installed -- runs nightly around 4am.');
}

function runDiagnostics() {
  var started = Date.now();
  var report = { generatedAt: new Date().toISOString(), codeVersion: CODE_VERSION, warnings: [], publicWarnings: [], info: [], timings: [], perf: [], sheets: [], integrity: [] };
  // publicMsg: version of the warning without player names, for getDiagnosticsSummary
  var warn = function(msg, publicMsg) { report.warnings.push(msg); report.publicWarnings.push(publicMsg || msg); };
  var info = function(msg) { report.info.push(msg); };
  var section = function(name, fn) {
    try { fn(); } catch (e) { warn(name + ' check crashed: ' + e.message); }
  };

  section('Triggers', function() { diagTriggers_(report, warn, info); });
  section('Sheets', function() { diagSheets_(report, warn, info); });
  section('Endpoint timings', function() { diagTimings_(report, warn, info); });
  section('Cache', function() { diagCache_(report, warn, info); });
  section('Data integrity', function() { diagIntegrity_(report, warn, info); });
  section('Request log', function() { diagPerfLog_(report, warn, info); });

  report.durationMs = Date.now() - started;
  writeDiagnosticsReport_(report);
  saveDiagnosticsSummary_(report);
  if (report.warnings.length) emailDiagnostics_(report);
  Logger.log(renderDiagnosticsText_(report));
  return report;
}

// --- individual checks ------------------------------------------------------

function diagTriggers_(report, warn, info) {
  var handlers = ScriptApp.getProjectTriggers().map(function(t) { return t.getHandlerFunction(); });
  info('Installed triggers: ' + (handlers.length ? handlers.join(', ') : '(none)'));
  if (handlers.indexOf('keepWarm') < 0) warn('keepWarm trigger is NOT installed -- the state cache is cold for most users. Run installKeepWarmTrigger().');
  if (handlers.indexOf('weeklyMondaySnapshot') < 0) warn('Weekly line snapshot trigger is NOT installed -- opening lines won\'t be frozen automatically. Run installWeeklyTrigger().');
  // keepWarm only skips rebuilds while this flag is set -- keep it in sync with reality
  var watched = handlers.indexOf('onSheetChange') >= 0;
  try { PropertiesService.getScriptProperties().setProperty('sheetChangeTrigger', watched ? '1' : ''); } catch (e) {}
  if (!watched) info('onSheetChange trigger not installed -- keepWarm rebuilds the state every run (~288/day). Run installSheetChangeTrigger() once to cut that and make manual sheet edits show up instantly.');
  if (handlers.indexOf('autoBackfillMissingLines') < 0) warn('Missing-lines ESPN check is NOT installed -- games that get a line mid-week never become pickable. Run installAutoBackfillTrigger().');
  try {
    // An early "season finalized" flag blocks the real end-of-season archive (see
    // autoFinalizeSeasonIfComplete in Notifications.gs, fixed Sep 2026).
    var yr = Number(getSeasonConfig().year || new Date().getFullYear());
    var fin = PropertiesService.getScriptProperties().getProperty('season_finalized_' + yr);
    var mo = new Date().getMonth() + 1;
    if (fin && mo >= 8) warn('Season ' + yr + ' is marked finalized (' + fin + ') while the season is still in progress. Delete Script Property season_finalized_' + yr + ' so the real January archive runs; CareerHistory ' + yr + ' rows are partial until then.');
  } catch (e) {}
  try {
    var bf = JSON.parse(PropertiesService.getScriptProperties().getProperty('lastLineBackfill') || 'null');
    if (bf) {
      info('Last ESPN missing-lines check: ' + bf.at + ' (week ' + bf.week + ': ' + bf.added + ' added, ' + bf.stillNoLine + ' still without a line)');
      if (Date.now() - new Date(bf.at).getTime() > 26 * 3600000) warn('The ESPN missing-lines check hasn\'t run in over a day (last: ' + bf.at + ').');
    }
  } catch (e) {}
  var dupes = handlers.filter(function(h, i) { return handlers.indexOf(h) !== i; });
  if (dupes.length) warn('Duplicate triggers (each runs twice): ' + dupes.join(', '));
}

function diagSheets_(report, warn, info) {
  var ss = getSS();
  var totalCells = 0;
  ss.getSheets().forEach(function(sh) {
    var rows = sh.getLastRow(), cols = sh.getLastColumn();
    var maxCells = sh.getMaxRows() * sh.getMaxColumns();
    totalCells += maxCells;
    report.sheets.push({ name: sh.getName(), rows: rows, cols: cols, allocatedCells: maxCells });
  });
  report.sheets.sort(function(a, b) { return b.allocatedCells - a.allocatedCells; });
  info('Spreadsheet allocated cells: ' + totalCells.toLocaleString() + ' of 10,000,000 limit');
  if (totalCells > 5000000) warn('Spreadsheet is over half the 10M cell limit (' + totalCells.toLocaleString() + ') -- every read gets slower as it grows.');

  // Old per-request DebugLog tab: no longer written to. Trim it so it stops slowing the spreadsheet.
  var dbg = ss.getSheetByName('DebugLog');
  if (dbg && dbg.getLastRow() > 501) {
    var remove = dbg.getLastRow() - 501;
    dbg.deleteRows(2, remove);
    info('Trimmed ' + remove + ' old rows from DebugLog (kept the newest 500). It is no longer written to; you can delete the tab.');
  }
  // PerfLog retention
  var perf = ss.getSheetByName('PerfLog');
  if (perf && perf.getLastRow() > 1) {
    var cutoff = Date.now() - PERF_LOG_KEEP_DAYS * 86400000;
    var ts = perf.getRange(2, 1, perf.getLastRow() - 1, 1).getValues();
    var old = 0;
    while (old < ts.length && new Date(ts[old][0]).getTime() < cutoff) old++;
    if (old > 0) { perf.deleteRows(2, old); info('Trimmed ' + old + ' PerfLog rows older than ' + PERF_LOG_KEEP_DAYS + ' days.'); }
  }
  // Avatars stored inline in Players are read on nearly every request
  var big = sheetToObjects(SHEET_NAMES.PLAYERS).filter(function(p) { return p.avatar && String(p.avatar).length > 45000; });
  if (big.length) warn(big.length + ' player avatar(s) are near the 50,000-character cell limit: ' + big.map(function(p) { return p.teamName; }).join(', '),
    big.length + ' player avatar(s) are near the 50,000-character cell limit.');
}

// Times each read feature the way a real request would run it (fresh request cache).
function diagTimings_(report, warn, info) {
  var week = Number(getSeasonConfig().currentWeek || 1);
  var tests = [
    { name: 'getState (cache warm)', fn: function() { return apiGetState({}); } },
    { name: 'getState (cold rebuild)', fn: function() { return { ok: true, _b: buildSharedState_() }; } },
    { name: 'getStandings', fn: function() { return apiGetStandings({}); } },
    { name: 'getBowlStandings', fn: function() { return apiGetBowlStandings({}); } },
    { name: 'getAllTimeLeaderboard', fn: function() { return apiGetAllTimeLeaderboard(); } },
    { name: 'getCareerHistory', fn: function() { return apiGetCareerHistory(); } },
    { name: 'getMessages', fn: function() { return apiGetMessages({ type: 'general' }); } },
    { name: 'ESPN scoreboard fetch', fn: function() { var ev = fetchEspnScoreboard(); return { ok: ev.length > 0, error: ev.length ? '' : 'ESPN returned no events', count: ev.length }; } }
  ];
  tests.forEach(function(t) {
    _sheetDataCache = {};
    var t0 = Date.now(), res, err = '';
    try { res = t.fn(); } catch (e) { err = e.message; }
    var ms = Date.now() - t0;
    var size = 0;
    try { size = JSON.stringify(res || {}).length; } catch (e) {}
    var ok = !err && res && res.ok !== false;
    report.timings.push({ name: t.name, ms: ms, ok: ok, bytes: size, error: err || (res && res.ok === false ? res.error : '') });
    if (!ok) warn(t.name + ' FAILED: ' + (err || (res && res.error) || 'unknown error'));
    else if (ms > 8000) warn(t.name + ' took ' + ms + 'ms (target < 8000ms)');
    if (size > 1500000) warn(t.name + ' returns ' + Math.round(size / 1024) + 'KB -- large payloads are slow on phones.');
  });
  _sheetDataCache = {};
}

function diagCache_(report, warn, info) {
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get(STATE_CACHE_KEY + '_n') || 0);
  info('State cache: ' + (n ? ('present (' + n + ' chunk' + (n > 1 ? 's' : '') + ')') : 'EMPTY'));
  var size = JSON.stringify(buildSharedState_()).length;
  info('Shared state size: ' + Math.round(size / 1024) + 'KB');
  if (size > 20 * CACHE_CHUNK) warn('Shared state (' + Math.round(size / 1024) + 'KB) is too big to cache at all -- every getState is a full rebuild.');
  _sheetDataCache = {};
}

function diagIntegrity_(report, warn, info) {
  var season = getSeasonConfig();
  var week = Number(season.currentWeek || 1);
  var games = sheetToObjects(SHEET_NAMES.GAMES);
  var gamesById = {};
  games.forEach(function(g) { gamesById[g.gameId] = g; });
  var picks = sheetToObjects(SHEET_NAMES.PICKS);
  var isTrue = function(v) { return v === true || v === 'TRUE'; };

  // duplicate straight picks, multiple upset picks
  var seen = {}, upsetCount = {}, dupes = 0, multiUpset = 0, favUpsets = 0;
  picks.forEach(function(p) {
    if (isTrue(p.isUpset)) {
      var uk = p.playerId + '|' + p.week;
      upsetCount[uk] = (upsetCount[uk] || 0) + 1;
      var g = gamesById[p.gameId];
      if (g && String(g.favorite).trim() !== '' && p.pickedTeam === g.favorite) favUpsets++;
    } else {
      var k = p.playerId + '|' + p.week + '|' + p.gameId;
      if (seen[k]) dupes++;
      seen[k] = true;
    }
  });
  Object.keys(upsetCount).forEach(function(k) { if (upsetCount[k] > 1) multiUpset++; });
  report.integrity.push({ check: 'Duplicate straight picks', count: dupes });
  report.integrity.push({ check: 'Player-weeks with >1 Upset Special', count: multiUpset });
  report.integrity.push({ check: 'Upset Specials placed on the favorite', count: favUpsets });
  if (dupes) warn(dupes + ' duplicate straight pick row(s) -- these can inflate scores. See auditAndFixDuplicatePicks().');
  if (multiUpset) warn(multiUpset + ' player-week(s) have more than one Upset Special. See findAndFixDuplicateUpsetPicks().');
  if (favUpsets) warn(favUpsets + ' Upset Special pick(s) are on the favorite (should be impossible).');

  // legacy players who never changed the old shared default PIN
  var defaultPin = sheetToObjects(SHEET_NAMES.PLAYERS).filter(function(p) {
    return isTrue(p.active) && String(p.pin).trim() === '1234';
  });
  report.integrity.push({ check: 'Active players still on default PIN 1234', count: defaultPin.length });
  if (defaultPin.length) warn(defaultPin.length + ' active player(s) still use the default PIN 1234 (anyone can log in as them): ' + defaultPin.map(function(p) { return p.teamName; }).join(', '),
    defaultPin.length + ' active player(s) still use the default PIN 1234.');

  // PINs chosen with a leading 0 before that was blocked: Sheets may have stored
  // "0123" as 123, so the player's real PIN no longer matches at login.
  var shortPin = sheetToObjects(SHEET_NAMES.PLAYERS).filter(function(p) {
    return isTrue(p.active) && String(p.pin).trim() !== '' && String(p.pin).trim().length < 4;
  });
  report.integrity.push({ check: 'Active players whose stored PIN lost a leading 0', count: shortPin.length });
  if (shortPin.length) warn(shortPin.length + ' player(s) have a stored PIN under 4 digits (a leading 0 was probably dropped, so they may be locked out) -- reset in the Players tab: ' + shortPin.map(function(p) { return p.teamName; }).join(', '),
    shortPin.length + ' player(s) have a stored PIN under 4 digits (a leading 0 was probably dropped).');

  // current week board health
  var board = games.filter(function(g) { return Number(g.week) === week && g.source !== 'external'; });
  var noLine = board.filter(function(g) { return g.favorite === '' || g.spread === '' || g.kickoff === ''; });
  report.integrity.push({ check: 'Week ' + week + ' board games', count: board.length });
  if (board.length && board.every(function(g) { return isTrue(g.locked); }) && noLine.length) {
    warn('Week ' + week + ': ' + noLine.length + ' posted game(s) missing a line or kickoff.');
  }
  var snapCount = sheetToObjects(SHEET_NAMES.LINE_SNAPSHOT).filter(function(r) { return Number(r.week) === week; }).length;
  report.integrity.push({ check: 'Week ' + week + ' line snapshot rows', count: snapCount });
  if (board.length && board.every(function(g) { return isTrue(g.locked); }) && snapCount === 0) {
    warn('Week ' + week + ' is posted but has NO line snapshot -- Upset Special search will be empty.');
  }
  // games that kicked off > 12h ago but still aren't final
  var stale = games.filter(function(g) {
    return Number(g.week) === week && !isTrue(g.isFinal) && g.kickoff && (Date.now() - new Date(g.kickoff).getTime() > 12 * 3600000);
  });
  report.integrity.push({ check: 'Week ' + week + ' games >12h past kickoff but not final', count: stale.length });
  if (stale.length) warn(stale.length + ' week ' + week + ' game(s) kicked off 12+ hours ago but have no final score -- run Fetch Results.');
}

function diagPerfLog_(report, warn, info) {
  var sheet = getSS().getSheetByName('PerfLog');
  if (!sheet || sheet.getLastRow() < 2) { info('PerfLog is empty (it fills as people use the app).'); return; }
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues();
  // players' own failed saves (reported from their phones) -- always surfaced
  var clientFails = rows.filter(function(r) { return r[5] === 'client' && new Date(r[0]).getTime() >= Date.now() - 86400000; });
  if (clientFails.length) warn(clientFails.length + ' failure(s) reported from players\' phones in the last 24h: ' +
    clientFails.slice(0, 5).map(function(r) { var n = {}; try { n = JSON.parse(r[6] || '{}'); } catch (e) {} return (n.team || '?') + ' ' + r[1] + ' "' + r[4] + '"'; }).join('; '),
    clientFails.length + ' failure(s) reported from players\' phones in the last 24h: ' +
    clientFails.slice(0, 5).map(function(r) { return r[1] + ' "' + r[4] + '"'; }).join('; '));
  var since = Date.now() - 7 * 86400000;
  var byAction = {};
  rows.forEach(function(r) {
    if (new Date(r[0]).getTime() < since) return;
    var a = r[1];
    var s = byAction[a] = byAction[a] || { action: a, samples: [], slow: 0, errors: 0, errorMsgs: {} };
    s.samples.push(Number(r[2]) || 0);
    if (r[5] === 'slow') s.slow++;
    if (r[5] === 'error') { s.errors++; s.errorMsgs[r[4]] = (s.errorMsgs[r[4]] || 0) + 1; }
  });
  var pct = function(arr, p) { var a = arr.slice().sort(function(x, y) { return x - y; }); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
  Object.keys(byAction).forEach(function(a) {
    var s = byAction[a];
    var topErr = Object.keys(s.errorMsgs).sort(function(x, y) { return s.errorMsgs[y] - s.errorMsgs[x]; })[0] || '';
    report.perf.push({ action: a, logged: s.samples.length, p50: pct(s.samples, 0.5), p95: pct(s.samples, 0.95), max: Math.max.apply(null, s.samples), slow: s.slow, errors: s.errors, topError: topErr });
  });
  report.perf.sort(function(x, y) { return (y.slow + y.errors) - (x.slow + x.errors) || y.p95 - x.p95; });
  report.perf.forEach(function(p) {
    // user-facing requests must finish well inside the frontend's 25s timeout
    if (p.max >= 25000 && p.action !== 'keepWarm') warn(p.action + ': at least one request took ' + Math.round(p.max / 1000) + 's in the last 7 days (the app gives up at 25s).');
    if (p.errors >= 5 && p.topError !== 'Admin access required.' ) warn(p.action + ': ' + p.errors + ' errors in the last 7 days (most common: "' + p.topError + '").');
  });
}

// --- output -------------------------------------------------------------------

function renderDiagnosticsText_(r) {
  var out = [];
  out.push('UPSET SPECIAL DIAGNOSTICS -- ' + r.generatedAt + ' (code ' + r.codeVersion + ', ran in ' + r.durationMs + 'ms)');
  out.push('');
  out.push(r.warnings.length ? ('WARNINGS (' + r.warnings.length + '):') : 'No warnings -- everything checked out.');
  r.warnings.forEach(function(w) { out.push('  ! ' + w); });
  out.push('');
  out.push('ENDPOINT TIMINGS (measured just now):');
  r.timings.forEach(function(t) { out.push('  ' + (t.ok ? 'ok  ' : 'FAIL') + '  ' + pad_(t.ms + 'ms', 8) + pad_(Math.round(t.bytes / 1024) + 'KB', 8) + t.name + (t.error ? '  -- ' + t.error : '')); });
  if (r.perf.length) {
    out.push('');
    out.push('REAL REQUESTS, LAST 7 DAYS (slow + failed + ' + Math.round(PERF_SAMPLE_RATE * 100) + '% sample):');
    out.push('  ' + pad_('action', 30) + pad_('p50', 8) + pad_('p95', 8) + pad_('max', 8) + pad_('slow', 6) + 'errors');
    r.perf.forEach(function(p) { out.push('  ' + pad_(p.action, 30) + pad_(p.p50, 8) + pad_(p.p95, 8) + pad_(p.max, 8) + pad_(p.slow, 6) + p.errors + (p.topError ? '  (' + p.topError + ')' : '')); });
  }
  out.push('');
  out.push('DATA INTEGRITY:');
  r.integrity.forEach(function(c) { out.push('  ' + pad_(c.count, 6) + c.check); });
  out.push('');
  out.push('LARGEST SHEETS:');
  r.sheets.slice(0, 8).forEach(function(s) { out.push('  ' + pad_(s.rows + ' rows', 14) + pad_(s.allocatedCells.toLocaleString() + ' cells', 18) + s.name); });
  out.push('');
  out.push('INFO:');
  r.info.forEach(function(i) { out.push('  - ' + i); });
  return out.join('\n');
}

function pad_(v, n) { v = String(v); while (v.length < n) v += ' '; return v + ' '; }

function writeDiagnosticsReport_(r) {
  var ss = getSS();
  var rep = ss.getSheetByName('DiagnosticsReport') || ss.insertSheet('DiagnosticsReport');
  rep.clear();
  var lines = renderDiagnosticsText_(r).split('\n').map(function(l) { return [l]; });
  rep.getRange(1, 1, lines.length, 1).setValues(lines).setFontFamily('Courier New');
  rep.setColumnWidth(1, 1100);

  var hist = ss.getSheetByName('DiagnosticsHistory');
  if (!hist) {
    hist = ss.insertSheet('DiagnosticsHistory');
    hist.appendRow(['runAt', 'codeVersion', 'warnings', 'getStateWarmMs', 'getStateColdMs', 'standingsMs', 'leaderboardMs', 'espnMs', 'warningText']);
    hist.setFrozenRows(1);
  }
  var t = function(name) { var x = r.timings.filter(function(tt) { return tt.name === name; })[0]; return x ? x.ms : ''; };
  hist.appendRow([r.generatedAt, r.codeVersion, r.warnings.length, t('getState (cache warm)'), t('getState (cold rebuild)'), t('getStandings'), t('getAllTimeLeaderboard'), t('ESPN scoreboard fetch'), r.warnings.join(' | ').slice(0, 1000)]);
}

// Name-free copy of the latest report, served by getDiagnosticsSummary so the weekly
// improvement session can read real timings (the Drive connector can't read cells).
function saveDiagnosticsSummary_(r) {
  try {
    var summary = {
      generatedAt: r.generatedAt, codeVersion: r.codeVersion, durationMs: r.durationMs,
      warnings: r.publicWarnings, timings: r.timings, perf: r.perf.slice(0, 25),
      integrity: r.integrity,
      sheets: r.sheets.slice(0, 10).map(function(s) { return { name: /^Week \d+$|^[A-Z][A-Za-z]+$/.test(s.name) ? s.name : '(other)', rows: s.rows, allocatedCells: s.allocatedCells }; })
    };
    // Script Properties hold ~9KB per value. Cutting the JSON string at 8500 chars (as
    // before) produced invalid JSON whenever the report was big -- exactly the busy
    // weeks it's needed for. Shrink the least important parts until it fits instead.
    summary = JSON.parse(JSON.stringify(summary)); // own copy -- the report is still emailed after this
    var fit = function() { return JSON.stringify(summary).length <= 8500; };
    var clip = function(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
    if (!fit()) summary.perf.forEach(function(p) { p.topError = clip(p.topError, 60); });
    if (!fit()) summary.warnings = summary.warnings.map(function(w) { return clip(w, 200); });
    if (!fit()) summary.timings.forEach(function(t) { t.error = clip(t.error, 60); });
    if (!fit()) summary.sheets = summary.sheets.slice(0, 5);
    while (!fit() && summary.perf.length > 5) summary.perf.pop();
    while (!fit() && summary.warnings.length > 3) summary.warnings.pop();
    summary.truncated = !fit() || undefined;
    var json = JSON.stringify(summary);
    PropertiesService.getScriptProperties().setProperty('lastDiagnosticsSummary', json.length <= 8500 ? json : JSON.stringify({ generatedAt: r.generatedAt, codeVersion: r.codeVersion, truncated: true, warnings: summary.warnings.slice(0, 3) }));
  } catch (e) { Logger.log('Diagnostics summary save failed: ' + e.message); }
}

function apiGetDiagnosticsSummary() {
  var getRequests = [];
  try { getRequests = JSON.parse(CacheService.getScriptCache().get('getReqLog') || '[]'); } catch (e) {}
  var raw = PropertiesService.getScriptProperties().getProperty('lastDiagnosticsSummary');
  if (!raw) return { ok: true, summary: null, getRequests: getRequests };
  try { return { ok: true, summary: JSON.parse(raw), getRequests: getRequests }; }
  catch (e) { return { ok: true, summary: null, getRequests: getRequests, note: 'summary was truncated; see DiagnosticsReport tab' }; }
}

// Rolling record (last 40, kept 6h) of GET requests: time, the action asked for, and
// the NAMES of any other parameters -- never their values.
function noteGetRequest_(e) {
  try {
    var c = CacheService.getScriptCache();
    var list = JSON.parse(c.get('getReqLog') || '[]');
    var params = (e && e.parameter) || {};
    list.push({ at: new Date().toISOString(), action: String(params.action || '').slice(0, 40),
      params: Object.keys(params).filter(function(k) { return k !== 'action'; }).join(',').slice(0, 80) });
    c.put('getReqLog', JSON.stringify(list.slice(-40)), 21600);
  } catch (err) {}
}

function emailDiagnostics_(r) {
  try {
    var to = PropertiesService.getScriptProperties().getProperty('DIAG_EMAIL') || Session.getEffectiveUser().getEmail();
    if (!to) return;
    MailApp.sendEmail({
      to: to,
      subject: 'Upset Special diagnostics: ' + r.warnings.length + ' warning' + (r.warnings.length === 1 ? '' : 's'),
      body: renderDiagnosticsText_(r) + '\n\nFull report: the DiagnosticsReport tab in the league spreadsheet.'
    });
  } catch (e) { Logger.log('Diagnostics email failed: ' + e.message); }
}
