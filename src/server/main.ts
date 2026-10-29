/**
 * The Lucid server. One endpoint, POST /lesson, plus GET /health.
 *
 *   npm run server                  local, keys from .env
 *   npm run server -- --dev-no-auth local only: any bearer token counts as one test user
 *
 * Environment: MODEL_API_KEY, BASETEN_API_KEY (the model keys), PORT (8787),
 * LUCID_DAILY_CAP (300 lessons a day for everyone), LUCID_ENABLED ("false"
 * pauses the server). Requests are logged with status, outcome and time
 * only: never the diff, the lesson, the user or the token.
 */
import { createServer } from 'node:http';
import { runLucid } from '../engine/lucid';
import { createGitHubVerifier } from './github';
import { handleLesson, MAX_BODY_BYTES, type ServerDeps } from './handler';
import { DailyLimits } from './limits';

export const PER_USER_DAILY = 20;

const number = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const createLucidServer = (deps: ServerDeps) =>
  createServer(async (req, res) => {
    const started = Date.now();
    const send = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
      console.log(`${req.method} ${req.url} ${status}${typeof body.outcome === 'string' ? ` ${body.outcome}` : ''}${typeof body.error === 'string' ? ` ${body.error}` : ''} ${Date.now() - started}ms`);
    };

    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, enabled: deps.enabled() });
    if (req.method !== 'POST' || req.url !== '/lesson') return send(404, { error: 'not-found' });

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        send(413, { error: 'too-large' });
        req.destroy();
        return;
      }
      chunks.push(chunk as Buffer);
    }
    const reply = await handleLesson(req.headers.authorization, Buffer.concat(chunks).toString('utf8'), deps);
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
    runLesson: ({ diffText, title }) =>
      runLucid({ diffText, title, source: null, providers: { pick: 'baseten', write: 'meta' } }),
  };
  const port = number(process.env.PORT, 8787);
  const host = process.env.HOST ?? '0.0.0.0';
  createLucidServer(deps).listen(port, host, () => {
    console.log(`Lucid server on http://${host}:${port}${devNoAuth ? ' (dev: sign-in check off)' : ''}`);
  });
};

// Run when started directly (npm run server, or the bundled server.mjs), not when imported by tests.
if (process.argv[1] && /(?:main\.ts|server\.mjs)$/.test(process.argv[1])) main();
