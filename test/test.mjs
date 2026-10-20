// Test harness for @local/dsh-git-actions — pure-logic unit tests plus a
// scratch-repo enforcement matrix for the protection hooks.
// Fully self-contained: every scratch repo and fixture is created at runtime
// inside a unique temp-dir folder that is removed again on exit — the suite
// never reads or writes the repository's git-ignored .tmp.
// Run: node test/test.mjs   (from the repository root; or: npm test)
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const moduleUrl = (relative) => pathToFileURL(join(root, relative)).href;

// Scratch root for every fixture this suite needs: a fresh unique folder in
// the system temp dir, wiped when the process exits (success or failure).
const scratchRoot = join(tmpdir(), `dsh-git-actions-test-${process.pid}-${Date.now()}`);
process.on('exit', () => rmSync(scratchRoot, { recursive: true, force: true }));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

function eq(name, actual, expected) {
  const equal = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, equal, equal ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- import every shipped module (this is also the syntax check) ----------
const branch = await import(moduleUrl('lib/branch.js'));
const hooks = await import(moduleUrl('lib/hooks.js'));
const prompts = await import(moduleUrl('lib/prompts.js'));
const index = await import(moduleUrl('index.js'));

// --- resolveConfig ---------------------------------------------------------
const defaults = index.resolveConfig({});
eq('config defaults', { mainBranches: defaults.mainBranches, releasePattern: defaults.releasePattern, releasePushEnv: defaults.releasePushEnv },
  { mainBranches: ['main', 'master'], releasePattern: 'release/*', releasePushEnv: 'DSH_ALLOW_RELEASE_PUSH' });
eq('config dedupes', index.resolveConfig({ mainBranches: ['main', 'main'] }).mainBranches, ['main']);
for (const [name, raw] of [
  ['rejects unknown key', { nope: 1 }],
  ['rejects non-array mainBranches', { mainBranches: 'main' }],
  ['rejects shell-unsafe mainBranches', { mainBranches: ['main; rm -rf'] }],
  ['rejects empty mainBranches', { mainBranches: [] }],
  ['rejects star-less pattern', { releasePattern: 'release' }],
  ['rejects bad pattern chars', { releasePattern: 'release/*$x' }],
  ['rejects bad env name', { releasePushEnv: '1BAD' }],
  ['rejects non-object', 'x'],
]) {
  let threw = false;
  try {
    index.resolveConfig(raw);
  } catch {
    threw = true;
  }
  check(`config ${name}`, threw);
}
const schemaResult = index.Config['~standard'].validate({});
check('standard schema validates defaults', schemaResult.value !== undefined && schemaResult.issues === undefined);

// --- guards ----------------------------------------------------------------
check('main guard', branch.isMainBranch('main', defaults) && branch.isMainBranch('master', defaults));
check('main guard negative', !branch.isMainBranch('feature/x', defaults));
check('release guard', branch.isReleaseBranch('release/1.2.3', defaults) && branch.isReleaseBranch('release/', defaults));
check('release guard negative', !branch.isReleaseBranch('releases/1', defaults) && !branch.isReleaseBranch('hotfix/x', defaults));
check('nested release matches (protective)', branch.isReleaseBranch('release/a/b', defaults));

// --- parsing ---------------------------------------------------------------
const parsed1 = branch.parseCreateBranchInput('  feature/login  ');
eq('parse ok', { ok: parsed1.ok, source: parsed1.source, newName: parsed1.newName }, { ok: true, source: 'feature/login', newName: null });
const parsed2 = branch.parseCreateBranchInput('main new-thing');
eq('parse two tokens', { source: parsed2.source, newName: parsed2.newName }, { source: 'main', newName: 'new-thing' });
check('parse empty errors', !branch.parseCreateBranchInput('   ').ok);
check('parse three tokens errors', !branch.parseCreateBranchInput('a b c').ok);
check('parse dash source errors', !branch.parseCreateBranchInput('--exec x').ok);

// --- status classification ---------------------------------------------------
eq('status classification', branch.classifyStatus('A  added.txt\n M mod.txt\n?? new.txt\nR  old.txt -> renamed.txt\nMM both.txt\nUU merge.txt'), {
  staged: ['added.txt', 'old.txt -> renamed.txt', 'both.txt', 'merge.txt'],
  unstaged: ['mod.txt', 'both.txt', 'merge.txt'],
  untracked: ['new.txt'],
});

// --- branch refs -------------------------------------------------------------
eq('branch refs parse', branch.parseBranchRefs('refs/heads/main\nrefs/heads/feature/x\nrefs/remotes/origin/main\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/dev\n'),
  [
    { name: 'main', remote: false },
    { name: 'feature/x', remote: false },
    { name: 'origin/main', remote: true },
    { name: 'origin/dev', remote: true },
  ]);

// --- candidate ranking --------------------------------------------------------
const branchList = [
  { name: 'main', remote: false },
  { name: 'feature/login', remote: false },
  { name: 'feature/logout', remote: false },
  { name: 'origin/feature/login-2fa', remote: true },
  { name: 'chore/cleanup', remote: false },
];
const ranked = branch.rankCandidates(branchList, 'feautre/login');
check('ranking finds typo', ranked.length > 0 && ranked[0].name === 'feature/login', `top was ${ranked[0]?.name}`);
const ranked2 = branch.rankCandidates(branchList, 'login');
check('ranking substring', ranked2.some((entry) => entry.name === 'feature/login'));
check('ranking no false positive', branch.rankCandidates(branchList, 'zzz').length === 0);

// --- hook script content -------------------------------------------------------
const preCommit = hooks.preCommitScript(defaults);
check('pre-commit marker', preCommit.includes(hooks.HOOK_MARKER));
check('pre-commit main arms', preCommit.includes('main|master)'));
check('pre-commit LF only', !preCommit.includes('\r'));
check('pre-commit uses branch --show-current', preCommit.includes('git branch --show-current'));
const prePush = hooks.prePushScript(defaults);
check('pre-push marker', prePush.includes(hooks.HOOK_MARKER));
check('pre-push main arm', prePush.includes('refs/heads/main|refs/heads/master)'));
check('pre-push release arm', prePush.includes('refs/heads/release/*)'));
check('pre-push env check', prePush.includes('"${DSH_ALLOW_RELEASE_PUSH:-0}" != "1"'));
check('pre-push LF only', !prePush.includes('\r'));

// --- prompts ---------------------------------------------------------------------
const facts = {
  cwd: 'C:/repo',
  branch: 'release/2.0',
  releaseBranch: true,
  originExists: true,
  upstream: { name: 'origin/release/2.0', ahead: 1, behind: 0 },
  status: { staged: ['a.txt'], unstaged: [], untracked: ['b.txt'] },
  stagedStat: ' a.txt | 1 +',
  recentSubjects: ['feat: x'],
  hooks: { 'pre-commit': true, 'pre-push': true },
};
const draftPrompt = prompts.buildDraftCommitPrompt(facts, defaults, 'my note');
check('draft prompt mentions cwd/branch', draftPrompt.includes('C:/repo') && draftPrompt.includes('release/2.0'));
check('draft prompt is read-only', draftPrompt.includes('read-only')
  && draftPrompt.includes('never run `git add`, `git commit`, `git push`')
  && !draftPrompt.includes('git commit -F')
  && !draftPrompt.includes('git push origin')
  && !draftPrompt.includes('push -u')
  && !draftPrompt.includes('Approve —'));
check('draft prompt presents fenced message and stops', draftPrompt.includes('fenced markdown code block') && draftPrompt.includes('end your turn'));
check('draft prompt prescribes brief format', draftPrompt.includes('<type>: <brief description>')
  && draftPrompt.includes('feature/bugfix/docs/<any others actions>: <brief description>')
  && draftPrompt.includes('- change a')
  && draftPrompt.includes('- change b')
  && draftPrompt.includes('no long body paragraphs'));
check('draft prompt release rule kept for later pushes', draftPrompt.includes('DSH_ALLOW_RELEASE_PUSH=1') && draftPrompt.includes("when the user later asks to push"));
check('draft prompt confirms clean tree before later commit', draftPrompt.includes('When the user later asks to commit')
  && draftPrompt.includes('no non-staged change has appeared')
  && draftPrompt.includes('never sweep unexpected edits into the commit'));
check('draft prompt carries note', draftPrompt.includes('my note'));
const plainFacts = { ...facts, branch: 'feature/x', releaseBranch: false, upstream: null };
const plainPrompt = prompts.buildDraftCommitPrompt(plainFacts, defaults, '');
check('plain prompt drops release follow-up clause', !plainPrompt.includes('DSH_ALLOW_RELEASE_PUSH=1'));
const nothingStagedPrompt = prompts.buildDraftCommitPrompt(
  { ...facts, status: { staged: [], unstaged: ['b.txt'], untracked: [] }, stagedStat: '' },
  defaults,
  '',
);
check('nothing-staged prompt covers working tree', nothingStagedPrompt.includes('full working-tree change set') && nothingStagedPrompt.includes('git add <paths>'));
const fallbackPrompt = prompts.buildCreateBranchFallbackPrompt(
  { cwd: 'C:/repo', sourceName: 'feautre/login', candidates: branch.rankCandidates(branchList, 'feautre/login'), situation: 'choose the source branch' },
  defaults,
);
check('fallback prompt lists candidates', fallbackPrompt.includes('feature/login') && fallbackPrompt.includes('ask_user_question'));

// --- hooks install/remove in a plain directory -------------------------------------
const tmpDir = join(scratchRoot, 'hooks-dir-test');
mkdirSync(tmpDir, { recursive: true });
const foreign = '#!/bin/sh\necho foreign\n';
writeFileSync(join(tmpDir, 'pre-commit'), foreign);
const install = await hooks.installHooks(tmpDir, defaults, async (hook) => {
  check('conflict callback saw foreign hook', hook === 'pre-commit');
  return 'replace';
});
check('install done', install.status === 'done'
  && install.results.filter((entry) => entry.action === 'backed-up' || entry.action === 'installed' || entry.action === 'reinstalled').length === 3,
  JSON.stringify(install.results));
check('foreign hook backed up', existsSync(join(tmpDir, 'pre-commit.dsh-git-actions.bak'))
  && readFileSync(join(tmpDir, 'pre-commit.dsh-git-actions.bak'), 'utf8') === foreign);
check('our pre-commit written', readFileSync(join(tmpDir, 'pre-commit'), 'utf8') === hooks.preCommitScript(defaults));
check('our pre-push written', readFileSync(join(tmpDir, 'pre-push'), 'utf8') === hooks.prePushScript(defaults));
const inspect1 = await hooks.inspectHooks(tmpDir);
eq('inspect sees both', inspect1, { 'pre-commit': true, 'pre-push': true });
// idempotent reinstall without callback
const install2 = await hooks.installHooks(tmpDir, defaults, async () => {
  check('no conflict on our own hook', false);
  return 'cancel';
});
check('reinstall ok', install2.status === 'done');
const removal = await hooks.removeHooks(tmpDir);
check('remove restored backup', readFileSync(join(tmpDir, 'pre-commit'), 'utf8') === foreign);
check('remove removed pre-push', !existsSync(join(tmpDir, 'pre-push')));
check('remove reports', removal.some((entry) => entry.action === 'restored-backup') && removal.some((entry) => entry.action === 'removed'));

// ============================================================================
// Scratch-repo enforcement matrix (real git; hooks executed by git itself)
// ============================================================================
function git(cwd, args, env = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const repoDir = join(scratchRoot, 'hook-repo');
const originDir = join(scratchRoot, 'hook-origin.git');
mkdirSync(repoDir, { recursive: true });

const RUN_HOOK_TESTS = git(repoDir, ['--version']).code === 0;
if (RUN_HOOK_TESTS) {
  const g = (args, env) => git(repoDir, args, env);
  let r = g(['init', '-b', 'main']);
  check('scratch init', r.code === 0, r.stderr);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'dsh-git-actions test']);
  g(['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repoDir, 'file.txt'), 'one\n');
  g(['add', 'file.txt']);
  r = g(['commit', '-m', 'init']);
  check('initial commit (no hooks yet)', r.code === 0, r.stderr);
  mkdirSync(originDir, { recursive: true });
  r = git(originDir, ['init', '--bare', '-b', 'main']);
  check('bare origin init', r.code === 0, r.stderr);
  r = g(['remote', 'add', 'origin', originDir]);
  check('remote add', r.code === 0, r.stderr);
  r = g(['push', '-u', 'origin', 'main']);
  check('baseline push main before hooks', r.code === 0, r.stderr);

  // install hooks into the real hooks dir
  const installed = await hooks.installHooks(join(repoDir, '.git', 'hooks'), defaults, async () => 'replace');
  check('hooks installed into scratch repo', installed.status === 'done');

  // 1. commit on main refused
  writeFileSync(join(repoDir, 'file.txt'), 'two\n');
  g(['add', 'file.txt']);
  r = g(['commit', '-m', 'on main']);
  check('commit on main refused', r.code !== 0 && r.stderr.includes('refusing commit'), r.stderr);

  // 2. commit on feature branch allowed
  r = g(['checkout', '-b', 'feature/x']);
  check('checkout -b feature/x', r.code === 0, r.stderr);
  writeFileSync(join(repoDir, 'file.txt'), 'two\nplus\n');
  g(['add', 'file.txt']);
  r = g(['commit', '-m', 'feature work']);
  check('commit on feature branch allowed', r.code === 0, r.stderr);

  // 3. release branch: local commit allowed, push refused without parameter
  g(['checkout', '-b', 'release/1.0', 'main']);
  writeFileSync(join(repoDir, 'file.txt'), 'release\n');
  g(['add', 'file.txt']);
  r = g(['commit', '-m', 'release work']);
  check('local commit on release allowed', r.code === 0, r.stderr);
  r = g(['push', '-u', 'origin', 'release/1.0']);
  check('release push refused without parameter', r.code !== 0 && r.stderr.includes('DSH_ALLOW_RELEASE_PUSH'), r.stderr);
  r = g(['push', '-u', 'origin', 'release/1.0'], { DSH_ALLOW_RELEASE_PUSH: '1' });
  check('release push allowed with parameter', r.code === 0, r.stderr);

  // 4. release deletion needs the parameter too
  r = g(['push', 'origin', ':release/1.0']);
  check('release delete refused without parameter', r.code !== 0 && r.stderr.includes('refused'), r.stderr);

  // 5. feature push flows freely
  r = g(['push', '-u', 'origin', 'feature/x']);
  check('feature push allowed', r.code === 0, r.stderr);

  // 6. main push refused even WITH the parameter (setup advances main via
  //    --no-verify: the pre-commit hook correctly blocks the normal path, so
  //    the test constructs the "main is ahead" state with the escape hatch
  //    just to give the pre-push hook something to refuse)
  g(['checkout', 'main']);
  writeFileSync(join(repoDir, 'file.txt'), 'main-advance\n');
  g(['add', 'file.txt']);
  r = g(['commit', '--no-verify', '-m', 'advance main (test setup bypass)']);
  check('setup: main advanced via --no-verify', r.code === 0, r.stderr);
  r = g(['push', 'origin', 'main'], { DSH_ALLOW_RELEASE_PUSH: '1' });
  check('main push refused even with parameter', r.code !== 0 && r.stderr.includes('no override'), r.stderr);

  // 7. delete of pushed release branch with the parameter is an explicit modification
  r = g(['push', 'origin', ':release/1.0'], { DSH_ALLOW_RELEASE_PUSH: '1' });
  check('release delete allowed with parameter', r.code === 0, r.stderr);

  // 8. removing hooks restores the baseline
  await hooks.removeHooks(join(repoDir, '.git', 'hooks'));
  r = g(['push', 'origin', 'main']);
  check('main push works after --remove', r.code === 0, r.stderr);
} else {
  check('git available for hook tests', false, 'git not on PATH');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILURES:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
