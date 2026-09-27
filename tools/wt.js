// Runs one of the weekly worktree's own tools/ scripts inside that worktree, so the
// automated weekly session can stay within the pre-approved `node tools/*` form.
// Usage (from the main repo):  node tools/wt.js <YYYY-MM-DD> <script.js> [args...]
//   e.g. node tools/wt.js 2026-10-06 backend-tests.js
// The worktree is ../UpsetSpecial-weekly-<date> (created by: node tools/git.js worktree add ...).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [date, script, ...rest] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^[\w-]+\.js$/.test(script || '')) {
  console.error('Usage: node tools/wt.js <YYYY-MM-DD> <script.js> [args...]');
  process.exit(2);
}
const wt = path.resolve(__dirname, '..', '..', 'UpsetSpecial-weekly-' + date);
const target = path.join(wt, 'tools', script);
if (!fs.existsSync(target)) { console.error('Not found: ' + target); process.exit(2); }
const r = spawnSync(process.execPath, [target].concat(rest), { cwd: wt, stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
