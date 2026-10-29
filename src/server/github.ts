/**
 * Who is asking: a GitHub token from the editor's built-in sign-in is
 * checked against GitHub. Results are cached in memory for a few minutes,
 * keyed by a hash of the token (the token itself is never kept).
 */
import { createHash } from 'node:crypto';

export interface GitHubUser {
  id: string;
  login: string;
}

export const createGitHubVerifier = (
  fetchImpl: typeof fetch = fetch,
  { ttlMs = 10 * 60_000, now = Date.now }: { ttlMs?: number; now?: () => number } = {},
) => {
  const cache = new Map<string, { user: GitHubUser | null; until: number }>();

  /** The GitHub user behind this token, or null when GitHub rejects it. Throws when GitHub cannot be reached. */
  return async (token: string): Promise<GitHubUser | null> => {
    const key = createHash('sha256').update(token).digest('hex');
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.user;
    if (cache.size > 10_000) cache.clear();

    const res = await fetchImpl('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'lucid-server',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (res.status === 401) {
      cache.set(key, { user: null, until: now() + 60_000 });
      return null;
    }
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const body = (await res.json()) as { id?: number; login?: string };
    const user = typeof body.id === 'number' ? { id: String(body.id), login: body.login ?? '' } : null;
    cache.set(key, { user, until: now() + ttlMs });
    return user;
  };
};
