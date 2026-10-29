/**
 * Daily lesson limits: per GitHub user, and for everyone together. Counted
 * in memory only (nothing is stored), so a restart starts the day over.
 * Days are UTC.
 */

export interface LimitConfig {
  perUser: number;
  global: number;
}

export type LimitResult = { ok: true } | { ok: false; reason: 'user-limit' | 'daily-cap' };

export class DailyLimits {
  private day = '';
  private total = 0;
  private readonly used = new Map<string, number>();

  constructor(
    private readonly config: LimitConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Count one lesson for this user, if both limits allow it. */
  take(userId: string): LimitResult {
    const today = this.now().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.total = 0;
      this.used.clear();
    }
    const mine = this.used.get(userId) ?? 0;
    if (mine >= this.config.perUser) return { ok: false, reason: 'user-limit' };
    if (this.total >= this.config.global) return { ok: false, reason: 'daily-cap' };
    this.used.set(userId, mine + 1);
    this.total += 1;
    return { ok: true };
  }
}
