// Runs GitHub Desktop's bundled git (git isn't on PATH on this machine) with the
// given arguments, e.g. `node tools/git.js status`. Exists so automated sessions
// can be pre-approved for `node tools/*` instead of a version-specific git path.
//
// `push` is refused on purpose: pushing main deploys the live site, and only the
// owner does that (from GitHub Desktop).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
if (args.some(a => a === 'push')) {
  console.error('tools/git.js: "push" is not allowed here -- the owner pushes from GitHub Desktop.');
  process.exit(2);
}

function findGit() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'GitHubDesktop');
  if (fs.existsSync(base)) {
    const apps = fs.readdirSync(base).filter(d => /^app-\d/.test(d))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (let i = apps.length - 1; i >= 0; i--) {
      const exe = path.join(base, apps[i], 'resources', 'app', 'git', 'cmd', 'git.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return 'git'; // fall back to PATH
}

const r = spawnSync(findGit(), args, { stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
