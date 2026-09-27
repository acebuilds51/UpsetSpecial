// Prints the latest nightly diagnostics summary from the LIVE backend (read-only:
// the only request this script can make is getDiagnosticsSummary, which returns
// timings/warnings with no player names). Usage: node tools/diag.js
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/API_URL:\s*'([^']+)'/);
if (!m) { console.error('Could not find CONFIG.API_URL in index.html'); process.exit(1); }

fetch(m[1], { method: 'POST', body: JSON.stringify({ action: 'getDiagnosticsSummary' }), headers: { 'Content-Type': 'text/plain' } })
  .then(r => r.json())
  .then(d => { console.log(JSON.stringify(d, null, 2)); })
  .catch(e => { console.error('Request failed: ' + e.message); process.exit(1); });
