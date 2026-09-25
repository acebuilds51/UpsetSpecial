// Syntax-checks every inline <script> in index.html and the Apps Script backend.
// Usage: node tools/check-syntax.js
// Exits non-zero on the first parse error so it can gate commits / CI.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
let failed = false;

function check(label, code) {
  try {
    new vm.Script(code, { filename: label });
  } catch (e) {
    failed = true;
    console.error('SYNTAX ERROR in ' + label + ':\n  ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 3).join('\n'));
  }
}

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, n = 0;
while ((m = re.exec(html))) {
  n++;
  const line = html.slice(0, m.index).split('\n').length;
  check('index.html <script #' + n + ' @ line ' + line + '>', m[1]);
}

const gs = path.join(root, 'backend', 'Code.gs');
if (fs.existsSync(gs)) check('backend/Code.gs', fs.readFileSync(gs, 'utf8'));

if (failed) process.exit(1);
console.log('OK — ' + n + ' inline scripts + Code.gs parse cleanly');
