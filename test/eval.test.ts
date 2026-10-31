import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { alarms, cost, percentile, renderReport, summarize, tokens, type EvalProof, type EvalRow, type Prices } from '../src/eval/report';
import { evalCommits } from './evalCommits';

const prices: Prices = { pickReview: { input: 1, output: 2 }, writeAttack: { input: 3, output: 4 }, sandboxPerSecond: 0.01 };
const usage = (input: number, output: number) => ({ calls: 1, input, output, reasoning: 0 });
const meta = { date: '2026-10-31', gitSha: 'abc1234', models: 'm', where: 'Here', concurrency: 4, priceNote: 'guesses.' };

const proof = (over: Partial<EvalProof> = {}): EvalProof => ({
  status: 'proven', foundBy: 'attacker', before: 'blocked', action: 'read', role: 'bob', table: 'notes', query: 'select 1', reason: null, agentCalls: 3, ms: 10_000,
  usage: { attacker: usage(1000, 1000), judge: usage(0, 0) },
  ...over,
});

const row = (id: string, over: Partial<EvalRow> = {}): EvalRow => ({
  id, label: 'risky', what: 'x', source: 'authored', provable: false, error: null, outcome: 'warning', warned: true, category: 'data-exposure', severity: 'high',
  factCheck: 'passed', gated: false, proof: null, warningMs: 20_000, usage: { pick: usage(1000, 0), write: usage(0, 1000), review: null },
  ...over,
});

describe('the evaluation numbers', () => {
  it('takes the nearest rank, on any order', () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([], 0.5)).toBe(0);
  });

  it('counts tokens and cost across every step', () => {
    const r = row('a', { proof: proof() });
    expect(tokens(r)).toBe(4000);
    // pick 1000 in at $1; write 1000 out at $4; attacker 1000 in and out at $3 and $4; 10 s of sandbox.
    expect(cost(r, prices)).toBeCloseTo(0.001 + 0.004 + 0.003 + 0.004 + 0.1);
  });

  it('counts caught, missed and false warnings', () => {
    const x = summarize([row('a'), row('b', { warned: false }), row('c', { label: 'safe', warned: true }), row('d', { label: 'safe', warned: false })], prices);
    expect(x.risky).toEqual({ total: 2, caught: 1, missed: ['b'] });
    expect(x.safe).toEqual({ total: 2, warned: 1, falseWarnings: ['c'] });
  });

  it('tells a proof in the product from one the prover made alone', () => {
    const x = summarize(
      [
        row('in-product', { provable: true, gated: true, proof: proof() }),
        row('alone', { provable: true, warned: false, gated: false, proof: proof({ foundBy: 'probe' }) }),
        row('not-proven', { provable: true, gated: true, proof: proof({ status: 'not-reproduced', foundBy: null }) }),
      ],
      prices,
    );
    expect(x.proofs).toMatchObject({ provable: 3, inProduct: 1, proverAlone: 2, byProbe: 1, byAttacker: 1 });
  });

  it('leaves a commit whose run failed out of the numbers, and says so', () => {
    const x = summarize([row('a'), row('broken', { error: 'APIError 500', warned: false })], prices);
    expect(x.risky.total).toBe(1);
    expect(x.errors).toEqual(['broken']);
    expect(alarms(x).join()).toContain('failed to run and are not in the numbers: broken');
  });
});

describe('a false proof is never quiet', () => {
  it('flags one in the product at the top of the report', () => {
    const rows = [row('safe-1', { label: 'safe', gated: true, proof: proof() })];
    const x = summarize(rows, prices);
    expect(x.proofs.falseProofsInProduct).toEqual(['safe-1']);
    expect(alarms(x)[0]).toBe('🚨 FALSE PROOF in the product on safe commits: safe-1');
    const report = renderReport(rows, prices, meta);
    expect(report.indexOf('FALSE PROOF')).toBeLessThan(report.indexOf('## Summary'));
  });

  it('flags one the warning step hid: the prover alone on a commit that got no warning', () => {
    const x = summarize([row('safe-2', { label: 'safe', warned: false, gated: false, proof: proof() })], prices);
    expect(x.proofs.falseProofsInProduct).toEqual([]);
    expect(x.proofs.falseProofsProverAlone).toEqual(['safe-2']);
    expect(alarms(x).join()).toContain('FALSE PROOF by the prover alone on safe commits: safe-2');
  });

  it('flags false warnings and misses, and says so when a run is clean', () => {
    const noisy = renderReport([row('safe-3', { label: 'safe' }), row('missed', { warned: false })], prices, meta);
    expect(noisy).toContain('FALSE WARNING on safe commits: safe-3');
    expect(noisy).toContain('MISSED risky commits: missed');
    expect(renderReport([row('a')], prices, meta)).toContain('No false proofs, false warnings, misses or errors in this run.');
  });
});

describe('the evaluation commits', () => {
  const commits = evalCommits();

  it('has at least 20 commits, 12 risky and 8 safe, with unique ids', () => {
    expect(commits.length).toBeGreaterThanOrEqual(20);
    expect(commits.filter((c) => c.label === 'risky').length).toBeGreaterThanOrEqual(12);
    expect(commits.filter((c) => c.label === 'safe').length).toBeGreaterThanOrEqual(8);
    expect(new Set(commits.map((c) => c.id)).size).toBe(commits.length);
  });

  it('has 8 commits written by Muse Spark, 4 risky and 4 safe', () => {
    const fresh = commits.filter((c) => c.source === 'generated');
    expect(fresh).toHaveLength(8);
    expect(fresh.filter((c) => c.label === 'risky')).toHaveLength(4);
  });

  it('has held-out commits for the fairest number', () => {
    const held = commits.filter((c) => c.source === 'held-out');
    expect(held.length).toBeGreaterThanOrEqual(6);
    expect(held.filter((c) => c.label === 'safe').length).toBeGreaterThanOrEqual(2);
  });

  it('can prove only what has a database to build, and calls nothing safe provable', () => {
    for (const c of commits.filter((x) => x.provable)) {
      expect(c.setup, c.id).not.toBeNull();
      expect(c.label, c.id).toBe('risky');
    }
  });

  it('holds no realistic-looking keys, only the obvious placeholder', () => {
    const dirs = ['eval-generated', 'risky-commits', join('prover-app', 'commits')].map((d) => join(import.meta.dirname, 'fixtures', d));
    const text = dirs.flatMap((d) => readdirSync(d).map((n) => readFileSync(join(d, n), 'utf8'))).join('\n');
    const keys = text.match(/\b(?:sk|pk|rk)_(?:live|test)_\w+|\bwhsec_\w+|\beyJ[\w-]{10,}\.[\w-]{10,}|\bAKIA[0-9A-Z]{16}\b/g) ?? [];
    expect([...new Set(keys)]).toEqual(['sk_live_fakekeyfortests']);
  });
});
