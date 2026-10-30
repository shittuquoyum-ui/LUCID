/**
 * The sandbox the prover attacks: one Postgres in a Modal Sandbox (no
 * network, capped CPU and memory, destroyed after the proof). This file is
 * the Node side; deploy/prove_sandbox.py holds the Modal side (a thread of
 * the server function on Modal, a child process locally). Tests use their
 * own Sandbox instead.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface PsqlCall {
  db: string;
  /** postgres (the superuser, setup only), anon or authenticated. */
  user: 'postgres' | 'anon' | 'authenticated';
  sql: string;
  /** Connection settings, e.g. "-c statement_timeout=3000 -c request.jwt.claims=…". */
  options?: string;
  tuplesOnly?: boolean;
  timeoutS?: number;
}

export interface PsqlResult {
  /** psql's exit code. */
  code: number;
  /** Results and errors, in order. */
  out: string;
  ms: number;
}

export interface Sandbox {
  start(): Promise<void>;
  psql(call: PsqlCall): Promise<PsqlResult>;
  stop(): Promise<void>;
}

const brokerPath = (): string =>
  process.env.LUCID_SANDBOX_BROKER ?? fileURLToPath(new URL('../../deploy/prove_sandbox.py', import.meta.url));
const python = (): string => process.env.LUCID_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');

type Ask = (msg: object) => Promise<Record<string, unknown>>;

/** One proof's sandbox, driven through a broker that answers messages. */
const brokerSandbox = (ask: Ask, close: () => void = () => undefined): Sandbox => {
  let session: string | null = null;
  return {
    start: async () => {
      session = String((await ask({ op: 'start' })).session);
    },
    psql: async (call) => {
      if (!session) throw new Error('the sandbox is not started');
      const r = await ask({ op: 'psql', session, db: call.db, user: call.user, sql: call.sql, options: call.options ?? '', tuplesOnly: !!call.tuplesOnly, timeout: call.timeoutS ?? 30 });
      return { code: Number(r.code), out: String(r.stdout ?? ''), ms: Number(r.ms) };
    },
    stop: async () => {
      if (session) await ask({ op: 'stop', session }).catch(() => undefined);
      session = null;
      close();
    },
  };
};

/**
 * The Modal sandbox. On Modal, the broker is a thread of the server function
 * (LUCID_SANDBOX_URL, with LUCID_SANDBOX_TOKEN); locally, a child process.
 */
export const modalSandbox = (): Sandbox => {
  const url = process.env.LUCID_SANDBOX_URL;
  if (url) {
    const token = process.env.LUCID_SANDBOX_TOKEN ?? '';
    return brokerSandbox(async (msg) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(msg),
        signal: AbortSignal.timeout(120_000),
      });
      const reply = (await res.json()) as Record<string, unknown>;
      if (!reply.ok) throw new Error(String(reply.error));
      return reply;
    });
  }
  return childSandbox();
};

/** The broker as a child process: JSON lines over stdin and stdout. */
const childSandbox = (): Sandbox => {
  const child = spawn(python(), ['-u', brokerPath()], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, PYTHONWARNINGS: 'ignore', PYTHONIOENCODING: 'utf-8' },
  });
  const waiting: ((line: string) => void)[] = [];
  let buffer = '';
  let closed = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      waiting.shift()?.(line);
    }
  });
  const fail = () => {
    closed = true;
    while (waiting.length) waiting.shift()!('{"ok":false,"error":"the sandbox broker stopped"}');
  };
  child.on('exit', fail);
  child.on('error', fail);

  const ask = (msg: object): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      if (closed) return reject(new Error('the sandbox broker stopped'));
      waiting.push((line) => {
        const reply = JSON.parse(line) as Record<string, unknown>;
        if (reply.ok) resolve(reply);
        else reject(new Error(String(reply.error)));
      });
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    });

  return brokerSandbox(ask, () => {
    if (closed) return;
    child.stdin.end();
    setTimeout(() => child.kill(), 15_000).unref();
  });
};
