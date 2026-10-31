/**
 * Lucid in the editor. After each new commit, Lucid reads it in the
 * background and, when a lesson is ready, says so in a toast. "Show me" opens
 * the lesson card beside the editor. The builder never has to ask.
 *
 * By default the lesson is written on Lucid's server: the builder signs in
 * with GitHub, the diff is filtered here, and only the filtered diff is sent.
 * With their own keys (lucid.useOwnKeys, or an editor without GitHub
 * sign-in) the engine runs right here instead. Own keys live in the editor's
 * secret storage and are handed to the engine directly; they never touch
 * settings, files, process.env or logs.
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import pickConceptPrompt from '../../src/prompts/pickConcept.md';
import reviewLessonPrompt from '../../src/prompts/reviewLesson.md';
import reviewWarningPrompt from '../../src/prompts/reviewWarning.md';
import writeLessonPrompt from '../../src/prompts/writeLesson.md';
import writeWarningPrompt from '../../src/prompts/writeWarning.md';
import { toCard, type Card, type WarningCard } from '../../src/engine/card';
import { parseDiff } from '../../src/engine/diff';
import { runLucid, type CardKind, type LucidStep } from '../../src/engine/lucid';
import { useApiKeys } from '../../src/engine/model';
import { providePrompts } from '../../src/engine/prompts';
import { reportLines } from '../../src/terminal';
import { renderCardHtml } from '../../src/ui/cardHtml';
import { commitDiff, commitSubject, fileAt, filesAt, headCommit, lastReflogSubject, parentsOf, type CommitRef, type GitApi, type GitExtension, type GitRepository } from './git';
import { askProve, cardAfterProof, proveRequest, wantsProof, type CommitFiles } from './prove';
import { MISSING_KEYS, NO_LESSON, plainReason, provenToast } from './messages';
import { askServer, DEFAULT_SERVER_URL } from './server';
import { classifyHeadChange, RunQueue } from './trigger';

const SECRETS = { meta: 'lucid.metaApiKey', baseten: 'lucid.basetenApiKey' } as const;

const GITHUB_SCOPES = ['read:user'];
const NO_GITHUB = "This editor has no GitHub sign-in Lucid can use. Set your own API keys instead.";

const settings = () => vscode.workspace.getConfiguration('lucid');
/** lucid.lessons: "on" (default) or "off", which leaves only warnings. */
const lessonsOn = () => settings().get<string>('lessons', 'on') !== 'off';
const wantedKinds = (): CardKind[] => (lessonsOn() ? ['risk', 'lesson'] : ['risk']);

const STEP_TEXT: Record<LucidStep | 'reading' | 'server', string> = {
  reading: 'Reading the commit',
  server: "Checking your change on Lucid's server",
  picking: 'Looking for risks, and the one idea worth explaining',
  writing: 'Writing the card',
  'fact-checking': 'Fact-checking the card',
};

export function activate(context: vscode.ExtensionContext): void {
  providePrompts({
    pickConcept: pickConceptPrompt,
    writeLesson: writeLessonPrompt,
    reviewLesson: reviewLessonPrompt,
    writeWarning: writeWarningPrompt,
    reviewWarning: reviewWarningPrompt,
  });

  let lastCard: Card | undefined;
  /** The card the panel is showing; Copy uses its fix prompt, never text sent back by the page. */
  let shownCard: Card | undefined;
  let panel: vscode.WebviewPanel | undefined;
  let git: GitApi | undefined;

  // --- status bar -----------------------------------------------------------
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(status);
  const showIdle = () => {
    status.text = '$(eye) Lucid';
    status.tooltip = lastCard ? 'Lucid: show the last lesson' : 'Lucid: explain my last commit';
    status.command = 'lucid.statusClick';
  };
  const showBusy = (step: keyof typeof STEP_TEXT) => {
    status.text = '$(sync~spin) Lucid is reading your change…';
    status.tooltip = `Lucid: ${STEP_TEXT[step]}…`;
    status.command = undefined;
  };
  showIdle();
  status.show();

  // --- keys -----------------------------------------------------------------
  const readKeys = async (): Promise<{ meta: string; baseten: string } | null> => {
    const [meta, baseten] = await Promise.all([context.secrets.get(SECRETS.meta), context.secrets.get(SECRETS.baseten)]);
    return meta && baseten ? { meta, baseten } : null;
  };
  const askForKeys = (message = MISSING_KEYS) =>
    void vscode.window.showWarningMessage(message, 'Set keys').then((choice) => {
      if (choice === 'Set keys') void vscode.commands.executeCommand('lucid.setKeys');
    });

  const setKeys = async () => {
    const ask = (title: string, prompt: string) =>
      vscode.window.showInputBox({ title, prompt: `${prompt} Saved in the editor's secret storage. Leave empty to keep the current key.`, password: true, ignoreFocusOut: true });
    const meta = await ask('Lucid: Meta API key', 'Your Meta Model API key (writes the lessons).');
    if (meta === undefined) return;
    const baseten = await ask('Lucid: Baseten API key', 'Your Baseten API key (picks the idea and fact-checks).');
    if (baseten === undefined) return;
    if (meta.trim()) await context.secrets.store(SECRETS.meta, meta.trim());
    if (baseten.trim()) await context.secrets.store(SECRETS.baseten, baseten.trim());
    void vscode.window.showInformationMessage((await readKeys()) ? 'Lucid: keys saved.' : 'Lucid: a key is still missing. Run "Lucid: Set API keys" again.');
  };

  // --- the card panel ---------------------------------------------------------
  const showCard = (card: Card) => {
    const html = renderCardHtml(card, { webview: { nonce: randomBytes(16).toString('hex') } });
    shownCard = card;
    if (panel) {
      panel.webview.html = html;
      panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    panel = vscode.window.createWebviewPanel(
      'lucid.lesson',
      'Lucid',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, enableCommandUris: false, localResourceRoots: [] },
    );
    panel.webview.html = html;
    const view = panel.webview;
    // "Copy" on a warning card: the page only asks; the text comes from our own copy of the card.
    view.onDidReceiveMessage(
      async (message: { type?: string }) => {
        if (message?.type !== 'copy-fix' || shownCard?.kind !== 'risk') return;
        await vscode.env.clipboard.writeText(shownCard.fixPrompt);
        void view.postMessage({ type: 'copied' });
      },
      null,
      context.subscriptions,
    );
    panel.onDidDispose(() => (panel = undefined), null, context.subscriptions);
  };

  /** A card changed after it was shown (the prover's result): keep the newest, redraw it if it is open. */
  const replaceCard = (old: Card, updated: Card) => {
    if (lastCard === old) lastCard = updated;
    if (panel && shownCard === old) {
      shownCard = updated;
      panel.webview.html = renderCardHtml(updated, { webview: { nonce: randomBytes(16).toString('hex') } });
    }
  };

  // --- the prover -------------------------------------------------------------
  /**
   * A data-exposure warning is tested in Lucid's sandbox in the background:
   * the card is already showing. Proven -> the card says "Proven" and a second
   * toast appears. Anything else leaves the warning with one quiet line.
   */
  const proveInBackground = async (commit: CommitRef, diffText: string, card: WarningCard, token: string, serverUrl: string) => {
    const [parentSha] = await parentsOf(commit).catch(() => [] as string[]);
    const files = (c: CommitRef): CommitFiles => ({ paths: () => filesAt(c), read: (path) => fileAt(c, path) });
    const request = await proveRequest(parseDiff(diffText), files(commit), parentSha ? files({ ...commit, sha: parentSha }) : null).catch(() => null);
    if (!request) return;

    const running = askProve(serverUrl, token, request);
    vscode.window.setStatusBarMessage('$(beaker~spin) Lucid is testing this warning in a sandbox with fake users…', running);
    const answer = await running;
    if (answer.kind === 'problem') console.log(`[Lucid] ${commit.sha.slice(0, 7)} prover: ${answer.message}`);
    else console.log(`[Lucid] ${commit.sha.slice(0, 7)} prover: ${answer.result.status}${answer.result.reason ? ` (${answer.result.reason})` : ''}. ${answer.result.summary}`);
    const updated = cardAfterProof(card, answer);
    replaceCard(card, updated);
    if (updated.evidence === 'proven') {
      void vscode.window.showWarningMessage(provenToast(updated.title), 'Show me').then((choice) => {
        if (choice === 'Show me') showCard(updated);
      });
    }
  };

  // --- GitHub sign-in (for Lucid's server) ----------------------------------
  /** The session; 'none' when not signed in; 'unavailable' when this editor has no GitHub sign-in at all. */
  const githubSession = async (): Promise<vscode.AuthenticationSession | 'none' | 'unavailable'> => {
    try {
      return (await vscode.authentication.getSession('github', GITHUB_SCOPES, { silent: true })) ?? 'none';
    } catch {
      // Silent never prompts, so throwing means the provider is missing (possible in some editors, e.g. Cursor).
      return 'unavailable';
    }
  };
  const signIn = async (fresh = false): Promise<boolean> => {
    try {
      const options = fresh ? { forceNewSession: { detail: 'Lucid needs a new GitHub sign-in.' } } : { createIfNone: true };
      return !!(await vscode.authentication.getSession('github', GITHUB_SCOPES, options));
    } catch {
      return false; // cancelled, or no GitHub sign-in in this editor
    }
  };
  const askToSignIn = (commit: CommitRef | null, message = 'Sign in with GitHub so Lucid can explain your commits.', fresh = false) =>
    void vscode.window.showInformationMessage(message, 'Sign in').then(async (choice) => {
      if (choice === 'Sign in' && (await signIn(fresh)) && commit) queue.request(commit);
    });

  // --- one run --------------------------------------------------------------
  /**
   * Show what a run produced: a warning toast for a risk, an information toast
   * for a lesson, a quiet note for nothing. A warning the fact check dropped
   * stays quiet too: Lucid never says a change is fine, it just says nothing.
   */
  const present = (sha: string, outcome: string, card: Card | null, report: string[]) => {
    console.log(`[Lucid] ${sha.slice(0, 7)}\n${report.join('\n')}`);
    if (card?.kind === 'risk') {
      lastCard = card;
      void vscode.window.showWarningMessage(`⚠️ Lucid: ${card.title}`, 'Show me', 'Later').then((choice) => {
        if (choice === 'Show me') showCard(card);
      });
    } else if (card) {
      if (!lessonsOn()) return;
      lastCard = card;
      void vscode.window.showInformationMessage(`Lucid: ${card.title}`, 'Show me', 'Later').then((choice) => {
        if (choice === 'Show me') showCard(card);
      });
    } else if (outcome === 'lesson-failed' && lessonsOn()) {
      void vscode.window.showWarningMessage(NO_LESSON);
    } else {
      vscode.window.setStatusBarMessage(lessonsOn() ? 'Lucid: nothing to flag or explain in this commit' : 'Lucid: nothing to flag in this commit', 8000);
    }
  };

  const explain = async (commit: CommitRef) => {
    // Lucid's server by default; the builder's own keys when they chose that,
    // or when this editor has no GitHub sign-in.
    const keys = await readKeys();
    let token: string | null = null;
    if (settings().get<boolean>('useOwnKeys', false)) {
      if (!keys) return askForKeys();
    } else {
      const session = await githubSession();
      if (session === 'none') return askToSignIn(commit);
      if (session === 'unavailable') {
        if (!keys) return askForKeys(NO_GITHUB);
      } else {
        token = session.accessToken;
      }
    }

    showBusy('reading');
    try {
      const [diffText, title] = await Promise.all([commitDiff(commit), commitSubject(commit)]);

      if (token) {
        showBusy('server');
        const serverUrl = settings().get<string>('serverUrl', DEFAULT_SERVER_URL) || DEFAULT_SERVER_URL;
        const answer = await askServer(serverUrl, token, diffText, title, fetch, wantedKinds());
        if (answer.kind === 'done') {
          present(commit.sha, answer.outcome, answer.card, answer.report);
          if (wantsProof(answer.card) && settings().get<boolean>('prove', true)) {
            void proveInBackground(commit, diffText, answer.card, token, serverUrl);
          }
          return;
        }
        if (answer.kind === 'nothing-to-send') return present(commit.sha, 'no-readable-files', null, ['nothing left to send after filtering']);
        console.log(`[Lucid] ${commit.sha.slice(0, 7)} server: ${answer.message}`);
        if (answer.action === 'sign-in') return askToSignIn(commit, answer.message, true);
        return void vscode.window.showWarningMessage(answer.message);
      }

      useApiKeys(keys!);
      const report = await runLucid({
        diffText,
        source: null,
        title,
        providers: { pick: 'baseten', write: 'meta' },
        kinds: wantedKinds(),
        onStep: showBusy,
      });
      present(commit.sha, report.outcome, toCard(report), reportLines(report));
    } catch (err) {
      // Only the error's kind is logged: some services echo part of a rejected key in their messages.
      const e = err as { name?: string; status?: number };
      console.log(`[Lucid] ${commit.sha.slice(0, 7)} failed: ${e?.name ?? 'Error'}${e?.status ? ` ${e.status}` : ''}`);
      const problem = plainReason(err);
      if (problem.offerKeys) askForKeys(problem.message);
      else void vscode.window.showWarningMessage(problem.message);
    } finally {
      showIdle();
    }
  };
  const queue = new RunQueue<CommitRef>(explain);

  // --- watching for new commits ---------------------------------------------
  const autoExplain = () => settings().get<boolean>('autoExplain', true);
  const heads = new Map<GitRepository, string | undefined>();
  const watchers = new Map<GitRepository, vscode.Disposable>();

  const onRepoChange = (repo: GitRepository) => {
    const current = repo.state.HEAD?.commit;
    const previous = heads.get(repo);
    if (!current || current === previous) return;
    heads.set(repo, current); // before any await, so a burst of events sees the move once
    if (!autoExplain() || !git) return;
    const commit: CommitRef = { gitPath: git.git.path, root: repo.rootUri.fsPath, sha: current };
    void (async () => {
      try {
        const [parents, reflogSubject] = await Promise.all([parentsOf(commit), lastReflogSubject(commit.gitPath, commit.root)]);
        if (classifyHeadChange({ previous, current, parents, reflogSubject }) === 'new-commit') queue.request(commit);
      } catch {
        // Could not tell what happened to HEAD: stay quiet rather than guess.
      }
    })();
  };
  const watch = (repo: GitRepository) => {
    if (watchers.has(repo)) return;
    heads.set(repo, repo.state.HEAD?.commit);
    watchers.set(repo, repo.state.onDidChange(() => onRepoChange(repo)));
  };
  const unwatch = (repo: GitRepository) => {
    watchers.get(repo)?.dispose();
    watchers.delete(repo);
    heads.delete(repo);
  };
  context.subscriptions.push({ dispose: () => [...watchers.values()].forEach((w) => w.dispose()) });

  void (async () => {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) return;
    git = (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
    git.repositories.forEach(watch);
    context.subscriptions.push(git.onDidOpenRepository(watch), git.onDidCloseRepository(unwatch));
  })();

  /** The repository of the file being edited, or the first one. */
  const activeRepo = (): GitRepository | undefined => {
    const repos = git?.repositories ?? [];
    const file = vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase();
    return repos.find((r) => file?.startsWith(r.rootUri.fsPath.toLowerCase())) ?? repos[0];
  };

  // --- commands -------------------------------------------------------------
  const explainLastCommit = async () => {
    const repo = activeRepo();
    if (!git || !repo) {
      void vscode.window.showWarningMessage("Lucid couldn't find a git repository in this window.");
      return;
    }
    const root = repo.rootUri.fsPath;
    try {
      queue.request({ gitPath: git.git.path, root, sha: await headCommit(git.git.path, root) });
    } catch {
      void vscode.window.showWarningMessage("Lucid couldn't find a commit in this repository yet.");
    }
  };
  const showLastLesson = () => {
    if (lastCard) showCard(lastCard);
    else void vscode.window.showInformationMessage("Lucid hasn't written a lesson in this window yet.");
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('lucid.setKeys', setKeys),
    vscode.commands.registerCommand('lucid.signIn', async () => {
      if ((await githubSession()) === 'unavailable') return askForKeys(NO_GITHUB);
      if (await signIn()) void vscode.window.showInformationMessage('Lucid: signed in with GitHub. Your next commit gets a lesson.');
    }),
    vscode.commands.registerCommand('lucid.explainLastCommit', explainLastCommit),
    vscode.commands.registerCommand('lucid.showLastLesson', showLastLesson),
    vscode.commands.registerCommand('lucid.statusClick', () => (lastCard ? showCard(lastCard) : explainLastCommit())),
  );
}

export function deactivate(): void {}
