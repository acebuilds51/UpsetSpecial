// Runs the Cloudflare Worker's tests (worker/test/worker.test.js) under node's test runner,
// so they fit the pre-approved `node tools/*` form (and `node tools/wt.js <date> worker-tests.js`).
// Same as: node --test worker/test/worker.test.js
const path = require('path');
const { spawnSync } = require('child_process');

const file = path.join(__dirname, '..', 'worker', 'test', 'worker.test.js');
const r = spawnSync(process.execPath, ['--test', file], { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
