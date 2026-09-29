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

// Dead-button guard: a redesign once rebuilt the admin Pot tab's markup and dropped its
// handlers, so "Record" and "Mark Paid" silently did nothing for weeks. Every
// <button id="…"> must be looked up somewhere, and every data-* attribute on a button
// must be queried ([data-x]) or read (dataset.x) somewhere.
const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const dead = new Set();
const btnRe = /<button\b([^>]*)>/gi;
while ((m = btnRe.exec(html))) {
  const attrs = m[1];
  const id = (attrs.match(/\bid="([\w-]+)"/) || [])[1];
  // ids looked up through a template (`pref-${x}-btn`) count as used
  const parts = id ? id.split('-') : [];
  const viaTemplate = parts.some((_, i) => i > 0 && html.includes(parts.slice(0, i).join('-') + '-${'));
  if (id && html.split(id).length - 1 < 2 && !viaTemplate) dead.add('#' + id);
  (attrs.match(/\bdata-[\w-]+(?==)/g) || []).forEach(a => {
    const name = a.slice(5);
    if (!html.includes('[' + a) && !html.includes('dataset.' + camel(name))) dead.add('[' + a + ']');
  });
}
if (dead.size) {
  failed = true;
  console.error('BUTTONS WITH NO HANDLER in index.html (nothing looks them up): ' + [...dead].join(', '));
}

const backend = path.join(root, 'backend');
const gsFiles = fs.existsSync(backend) ? fs.readdirSync(backend).filter(f => f.endsWith('.gs')) : [];
gsFiles.forEach(f => check('backend/' + f, fs.readFileSync(path.join(backend, f), 'utf8')));

if (failed) process.exit(1);
console.log('OK — ' + n + ' inline scripts + ' + gsFiles.join(', ') + ' parse cleanly');
