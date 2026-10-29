/**
 * Lucid in the editor. After each new commit, Lucid reads it in the
 * background and, when a lesson is ready, says so in a toast. "Show me" opens
 * the lesson card beside the editor. The builder never has to ask.
 *
 * Keys live in the editor's secret storage and are handed to the engine
 * directly; they never touch settings, files, process.env or logs.
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import pickConceptPrompt from '../../src/prompts/pickConcept.md';
import reviewLessonPrompt from '../../src/prompts/reviewLesson.md';
import writeLessonPrompt from '../../src/prompts/writeLesson.md';
import { toCard, type LessonCard } from '../../src/engine/card';
import { runLucid, type LucidStep } from '../../src/engine/lucid';
import { useApiKeys } from '../../src/engine/model';
import { providePrompts } from '../../src/engine/prompts';
import { reportLines } from '../../src/terminal';
import { renderCardHtml } from '../../src/ui/cardHtml';
import { commitDiff, commitSubject, headCommit, lastReflogSubject, parentsOf, type CommitRef, type GitApi, type GitExtension, type GitRepository } from './git';
import { MISSING_KEYS, NO_LESSON, plainReason } from './messages';
import { classifyHeadChange, RunQueue } from './trigger';

const SECRETS = { meta: 'lucid.metaApiKey', baseten: 'lucid.basetenApiKey' } as const;

const STEP_TEXT: Record<LucidStep | 'reading', string> = {
  reading: 'Reading the commit',
  picking: 'Picking the one idea worth explaining',
  writing: 'Writing the lesson',
  'fact-checking': 'Fact-checking the lesson',
};

export function activate(context: vscode.ExtensionContext): void {
  providePrompts({ pickConcept: pickConceptPrompt, writeLesson: writeLessonPrompt, reviewLesson: reviewLessonPrompt });

  let lastCard: LessonCard | undefined;
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

  // --- the lesson panel -----------------------------------------------------
  const showCard = (card: LessonCard) => {
    const html = renderCardHtml(card, { webview: { nonce: randomBytes(16).toString('hex') } });
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
    panel.onDidDispose(() => (panel = undefined), null, context.subscriptions);
  };

  // --- one run --------------------------------------------------------------
  const explain = async (commit: CommitRef) => {
    const keys = await readKeys();
    if (!keys) return askForKeys();
    useApiKeys(keys);
    showBusy('reading');
    try {
      const [diffText, title] = await Promise.all([commitDiff(commit), commitSubject(commit)]);
      const report = await runLucid({
        diffText,
        source: null,
        title,
        providers: { pick: 'baseten', write: 'meta' },
        onStep: showBusy,
      });
      console.log(`[Lucid] ${commit.sha.slice(0, 7)}\n${reportLines(report).join('\n')}`);

      const card = toCard(report);
      if (card) {
        lastCard = card;
        void vscode.window.showInformationMessage(`Lucid: ${card.title}`, 'Show me', 'Later').then((choice) => {
          if (choice === 'Show me') showCard(card);
        });
      } else if (report.outcome === 'nothing-to-teach' || report.outcome === 'no-readable-files') {
        vscode.window.setStatusBarMessage('Lucid: nothing worth a lesson in this commit', 8000);
      } else {
        void vscode.window.showWarningMessage(NO_LESSON);
      }
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
  const autoExplain = () => vscode.workspace.getConfiguration('lucid').get<boolean>('autoExplain', true);
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
    vscode.commands.registerCommand('lucid.explainLastCommit', explainLastCommit),
    vscode.commands.registerCommand('lucid.showLastLesson', showLastLesson),
    vscode.commands.registerCommand('lucid.statusClick', () => (lastCard ? showCard(lastCard) : explainLastCommit())),
  );
}

export function deactivate(): void {}
