// The red-team evaluation on Modal: npm run eval:modal [-- --only a,b]
// Builds the bundles, runs run_eval in the server's image, and saves what it
// returns to samples/eval. UTF-8 output for the same reason as deploy.mjs.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const passed = process.argv.slice(2);
const at = passed.indexOf('--out');
const out = at >= 0 ? passed[at + 1] : join('samples', 'eval');
const rest = at >= 0 ? passed.filter((_, i) => i !== at && i !== at + 1) : passed;

const shell = process.platform === 'win32';
const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };

const built = spawnSync('node', ['scripts/build-server.mjs'], { stdio: 'inherit', shell, env });
if (built.status) process.exit(built.status);

const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', shell }).stdout.trim();
const result = join(tmpdir(), `lucid-eval-${process.pid}.json`);
const run = spawnSync('modal', ['run', '-w', result, 'deploy/modal_app.py::run_eval', '--arguments', `"${[...rest, '--sha', sha].join(' ')}"`], { stdio: 'inherit', shell, env });
if (run.status) process.exit(run.status);

const files = JSON.parse(readFileSync(result, 'utf8'));
mkdirSync(out, { recursive: true });
for (const [name, text] of Object.entries(files)) writeFileSync(join(out, name), text);
rmSync(result, { force: true });
console.log(`saved to ${out}`);
