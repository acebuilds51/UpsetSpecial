// Prints the latest nightly diagnostics summary from the LIVE backend (read-only:
// the only request this script can make is getDiagnosticsSummary, which returns
// timings/warnings with no player names). Usage: node tools/diag.js
//
// Sent as a GET with ?action= in the URL: Apps Script answers a POST with a 302
// redirect, and Node's fetch re-issues it as a GET WITHOUT the body -- so a POST
// arrived with no action and came back "No action.".
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/API_URL:\s*'([^']+)'/);
if (!m) { console.error('Could not find CONFIG.API_URL in index.html'); process.exit(1); }

const url = m[1] + (m[1].includes('?') ? '&' : '?') + 'action=getDiagnosticsSummary';
fetch(url, { signal: AbortSignal.timeout(60000) })
  .then(r => r.text())
  .then(t => {
    let d;
    try { d = JSON.parse(t); } catch (e) { console.error('Non-JSON reply (Google lost the response -- try again):\n' + t.slice(0, 300)); process.exit(1); }
    console.log(JSON.stringify(d, null, 2));
    if (d.ok === false) process.exit(1);
  })
  .catch(e => { console.error('Request failed: ' + e.message); process.exit(1); });
