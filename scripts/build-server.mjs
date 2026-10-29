// Bundles the Lucid server (and the engine) into dist/server.mjs for the
// Modal container. The prompt .md files are not bundled: the container gets
// them at /app/prompts, which is where the engine looks (../prompts from
// /app/dist/server.mjs).
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/server/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/server.mjs',
  // Some dependencies still call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __lucidRequire } from 'node:module'; const require = __lucidRequire(import.meta.url);" },
  logLevel: 'info',
});
