// Deploy the server to Modal (npm run deploy builds dist/server.mjs first).
// The Modal CLI prints ✓ marks; on Windows the console's default encoding
// cannot, and the deploy fails halfway. UTF-8 output fixes that everywhere.
import { spawnSync } from 'node:child_process';

const result = spawnSync('modal', ['deploy', 'deploy/modal_app.py'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
});
process.exit(result.status ?? 1);
