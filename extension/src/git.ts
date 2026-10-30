/**
 * Git, two ways: the editor's built-in git extension tells Lucid when HEAD
 * moves, and the git command line reads commits. Only the few pieces of the
 * built-in API that Lucid uses are typed here (extension "vscode.git",
 * getAPI(1)).
 */
import { execFile } from 'node:child_process';
import type { Event, Uri } from 'vscode';

export interface GitRepository {
  readonly rootUri: Uri;
  readonly state: {
    readonly HEAD: { readonly commit?: string; readonly name?: string } | undefined;
    readonly onDidChange: Event<void>;
  };
}

export interface GitApi {
  readonly git: { readonly path: string };
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: Event<GitRepository>;
  readonly onDidCloseRepository: Event<GitRepository>;
}

export interface GitExtension {
  getAPI(version: 1): GitApi;
}

export class GitError extends Error {
  override name = 'GitError';
}

/** Where a commit lives: the git binary, the repo root, the commit. */
export interface CommitRef {
  gitPath: string;
  root: string;
  sha: string;
}

const run = (gitPath: string, root: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    // No shell: arguments go to git as they are.
    execFile(gitPath, ['-c', 'core.quotepath=false', ...args], { cwd: root, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
      err ? reject(new GitError(`git ${args[0]} failed`)) : resolve(stdout),
    );
  });

/** The commit's own changes, as a unified diff. */
export const commitDiff = ({ gitPath, root, sha }: CommitRef): Promise<string> =>
  run(gitPath, root, ['show', sha, '--format=', '--patch', '--no-color', '--no-ext-diff']);

export const commitSubject = async ({ gitPath, root, sha }: CommitRef): Promise<string> =>
  (await run(gitPath, root, ['log', '-1', '--format=%s', sha])).trim();

export const parentsOf = async ({ gitPath, root, sha }: CommitRef): Promise<string[]> =>
  (await run(gitPath, root, ['rev-list', '--parents', '-n', '1', sha])).trim().split(/\s+/).slice(1);

/** Subject of the newest HEAD reflog entry; empty when there is none. */
export const lastReflogSubject = async (gitPath: string, root: string): Promise<string> => {
  try {
    return (await run(gitPath, root, ['reflog', '-1', '--format=%gs', 'HEAD'])).trim();
  } catch {
    return '';
  }
};

export const headCommit = async (gitPath: string, root: string): Promise<string> =>
  (await run(gitPath, root, ['rev-parse', 'HEAD'])).trim();

/** Every file path in a commit's tree. */
export const filesAt = async ({ gitPath, root, sha }: CommitRef): Promise<string[]> =>
  (await run(gitPath, root, ['ls-tree', '-r', '--name-only', sha])).split('\n').filter(Boolean);

/** One file as it was in a commit. */
export const fileAt = ({ gitPath, root, sha }: CommitRef, path: string): Promise<string> => run(gitPath, root, ['show', `${sha}:${path}`]);
