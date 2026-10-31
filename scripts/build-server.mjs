// Bundles the Lucid server (and the engine) into dist/server.mjs for the
// Modal container. The prompt .md files are not bundled: the container gets
// them at /app/prompts, which is where the engine looks (../prompts from
// /app/dist/server.mjs).
//
// Also bundles the prover's integration test (dist/prove-fixtures.mjs) and the
// red-team evaluation (dist/eval.mjs), which the prove_fixtures and run_eval
// functions in deploy/modal_app.py run in the same image.
import * as esbuild from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Some dependencies still call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __lucidRequire } from 'node:module'; const require = __lucidRequire(import.meta.url);" },
  logLevel: 'info',
};

await esbuild.build({ ...common, entryPoints: ['src/server/main.ts'], outfile: 'dist/server.mjs' });
await esbuild.build({ ...common, entryPoints: ['scripts/prove-fixtures.ts'], outfile: 'dist/prove-fixtures.mjs' });
await esbuild.build({ ...common, entryPoints: ['scripts/eval.ts'], outfile: 'dist/eval.mjs' });
