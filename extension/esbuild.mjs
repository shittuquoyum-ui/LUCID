// Bundles the extension and the engine from ../src into dist/extension.js.
// Prompt .md files are inlined as text, so the bundle reads no files at run time.
import * as esbuild from 'esbuild';

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  loader: { '.md': 'text' },
  // The engine's prompt loader only reads files when no prompts were provided;
  // the extension always provides them, so this URL is never used.
  define: { 'import.meta.url': '"file:///lucid-extension/"' },
  sourcemap: true,
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  await (await esbuild.context(options)).watch();
} else {
  await esbuild.build(options);
}
