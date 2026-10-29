/**
 * When Lucid runs on its own, and how runs line up. Pure code, no editor API,
 * so it can be tested directly.
 */

export type HeadChange = 'new-commit' | 'other' | 'unchanged';

export interface HeadMove {
  /** HEAD before the change, as last seen; undefined until Lucid has seen one. */
  previous: string | undefined;
  current: string | undefined;
  /** Parents of the current commit. */
  parents: string[];
  /** Subject of the newest HEAD reflog entry, e.g. "commit: Fix login" or "pull: Fast-forward". */
  reflogSubject: string;
}

/**
 * A new commit is one the builder just made on top of what they had: one
 * parent, that parent is the previous HEAD, and git logged it as a commit.
 * A checkout, pull, merge, rebase, reset, amend or cherry-pick is not.
 * A pull that fast-forwards by one commit also has the old HEAD as parent;
 * only the reflog ("pull: ...") tells it apart.
 */
export const classifyHeadChange = ({ previous, current, parents, reflogSubject }: HeadMove): HeadChange => {
  if (!current || current === previous) return 'unchanged';
  if (!previous) return 'other';
  if (parents.length !== 1 || parents[0] !== previous) return 'other';
  return /^commit: /.test(reflogSubject) ? 'new-commit' : 'other';
};

/**
 * One run at a time. A request during a run is remembered and runs next; a
 * newer request replaces it, so at most one ever waits.
 */
export class RunQueue<T> {
  private running = false;
  private waiting: T | undefined;

  constructor(private readonly run: (job: T) => Promise<void>) {}

  get busy(): boolean {
    return this.running;
  }

  request(job: T): void {
    if (this.running) {
      this.waiting = job;
      return;
    }
    void this.drain(job);
  }

  private async drain(first: T): Promise<void> {
    this.running = true;
    let next: T | undefined = first;
    try {
      while (next !== undefined) {
        this.waiting = undefined;
        try {
          await this.run(next);
        } catch {
          // The run reports its own failures; the queue keeps going.
        }
        next = this.waiting;
      }
    } finally {
      this.running = false;
    }
  }
}
