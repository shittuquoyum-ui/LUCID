/**
 * The Lucid server: POST /lesson, POST /prove (the sandbox attack for a
 * data-exposure warning), and GET /health.
 *
 *   npm run server                  local, keys from .env
 *   npm run server -- --dev-no-auth local only: any bearer token counts as one test user
 *
 * Environment: MODEL_API_KEY, BASETEN_API_KEY (the model keys), PORT (8787),
 * LUCID_DAILY_CAP (300 lessons a day for everyone), LUCID_ENABLED ("false"
 * pauses the server), LUCID_PROVE_CAP (100 proofs a day for everyone),
 * LUCID_PROVE_ENABLED ("false" pauses the prover only). Requests are logged with status, outcome and time
 * only: never the diff, the lesson, the user or the token.
 */
import { createServer } from 'node:http';
import { runLucid } from '../engine/lucid';
import { createGitHubVerifier } from './github';
import { prove as runProof } from '../prover/prove';
import { handleLesson, handleProve, MAX_BODY_BYTES, MAX_PROVE_BODY_BYTES, type ProveDeps, type ServerDeps } from './handler';
import { DailyLimits } from './limits';

export const PER_USER_DAILY = 20;
export const PROOFS_PER_USER_DAILY = 5;

const number = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const createLucidServer = (deps: ServerDeps, prove?: ProveDeps) =>
  createServer(async (req, res) => {
    const started = Date.now();
    const send = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
      const result = body.result as { status?: string } | undefined;
      const outcome = typeof body.outcome === 'string' ? ` ${body.outcome}` : result?.status ? ` ${result.status}` : '';
      console.log(`${req.method} ${req.url} ${status}${outcome}${typeof body.error === 'string' ? ` ${body.error}` : ''} ${Date.now() - started}ms`);
    };

    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, enabled: deps.enabled(), prove: !!prove && prove.enabled() });
    const route = req.method === 'POST' && (req.url === '/lesson' || (req.url === '/prove' && prove)) ? req.url : null;
    if (!route) return send(404, { error: 'not-found' });

    const max = route === '/prove' ? MAX_PROVE_BODY_BYTES : MAX_BODY_BYTES;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > max) {
        send(413, { error: 'too-large' });
        req.destroy();
        return;
      }
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    const reply = route === '/prove' ? await handleProve(req.headers.authorization, body, deps, prove!) : await handleLesson(req.headers.authorization, body, deps);
    send(reply.status, reply.body);
  });

const main = () => {
  const devNoAuth = process.argv.includes('--dev-no-auth');
  for (const key of ['MODEL_API_KEY', 'BASETEN_API_KEY']) {
    if (!process.env[key]?.trim()) console.warn(`warning: ${key} is not set; lessons will fail`);
  }
  const verifyGitHub = createGitHubVerifier();
  const deps: ServerDeps = {
    enabled: () => process.env.LUCID_ENABLED?.trim().toLowerCase() !== 'false',
    verify: devNoAuth ? async () => ({ id: 'dev', login: 'dev' }) : verifyGitHub,
    limits: new DailyLimits({ perUser: PER_USER_DAILY, global: number(process.env.LUCID_DAILY_CAP, 300) }),
    runLesson: ({ diffText, title, kinds }) =>
      runLucid({ diffText, title, kinds, source: null, providers: { pick: 'baseten', write: 'meta' } }),
  };
  const prove: ProveDeps = {
    enabled: () => process.env.LUCID_PROVE_ENABLED?.trim().toLowerCase() !== 'false',
    limits: new DailyLimits({ perUser: PROOFS_PER_USER_DAILY, global: number(process.env.LUCID_PROVE_CAP, 100) }),
    runProof: (input) => runProof(input, { attacker: 'meta', judge: 'baseten' }),
  };
  const port = number(process.env.PORT, 8787);
  const host = process.env.HOST ?? '0.0.0.0';
  createLucidServer(deps, prove).listen(port, host, () => {
    console.log(`Lucid server on http://${host}:${port}${devNoAuth ? ' (dev: sign-in check off)' : ''}`);
  });
};

// Run when started directly (npm run server, or the bundled server.mjs), not when imported by tests.
if (process.argv[1] && /(?:main\.ts|server\.mjs)$/.test(process.argv[1])) main();
