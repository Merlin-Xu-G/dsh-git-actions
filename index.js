/**
 * @local/dsh-git-actions — Host half of the guarded git workflow bundle.
 *
 * Three human commands (registered through the `commands` service, the same
 * seam `@deepseek-ai/dsh-plan-mode` uses for `/plan`):
 *
 * - `/draft-commit [note]` — verifies the repository, branch, and change
 *   state host-side, refuses to run on a protected main branch, then steers
 *   one READ-ONLY procedure prompt into the session's agent: review the
 *   changes, draft the commit message, print it as a fenced markdown block,
 *   and return control to the user. No commits, pushes, staging, or
 *   questions — committing and pushing happen later, only when the user
 *   asks for them in conversation (release-branch pushes keep the
 *   explicit-confirmation + parameter rule).
 * - `/create-branch-from <source-branch> [new-branch]` — resolves the source
 *   branch host-side (local or origin); when the name misses, ranks similar
 *   branches and asks the user to pick; validates the new name; refuses main
 *   names, confirms release names; then creates and switches to the branch.
 * - `/setup-protect-branch-hook [--remove]` — installs (or removes) the
 *   `pre-commit` / `pre-push` protection hooks: main branches are never
 *   touched, release branches are pushed only with the explicit parameter
 *   (default `DSH_ALLOW_RELEASE_PUSH=1`). Existing foreign hooks are backed
 *   up, never silently destroyed.
 *
 * Contracts coded against (verified against the installed Harness):
 * - `ctx.commands.register({ name, description, input: { hint },
 *    recordInput, handler })`; the handler receives
 *    `{ agent, rawInput, attachments, signal }`, is awaited, and returns
 *    `{ kind: 'success', text? }` or `{ kind: 'error', text }`.
 * - `agent.steer(userMessage)` inserts the message for the next step AND
 *    wakes the driver; the message shape matches dsh-llm's
 *    `createUserMessage` (`{ role: 'user', content, source: { kind: 'user'
 *    }, id }`, deep-frozen — the id brand is a compile-time no-op).
 * - `ctx.get('subprocess' | 'workingDirectory' | 'userQuestions')` —
 *    optional services; every absence degrades to a clear error or an agent
 *    fallback, so the plugin stays mountable wherever commands exist.
 * - `export const Config` implements the Standard Schema `~standard`
 *    protocol cordis `resolveConfig` calls — dependency-free.
 */
import { randomUUID } from 'node:crypto';

import {
  classifyStatus,
  isMainBranch,
  isReleaseBranch,
  parseCreateBranchInput,
  rankCandidates,
} from './lib/branch.js';
import { createGitKit } from './lib/git.js';
import { inspectHooks, installHooks, isSafeShellBranchName, removeHooks } from './lib/hooks.js';
import { buildCreateBranchFallbackPrompt, buildDraftCommitPrompt } from './lib/prompts.js';

const CONFIG_KEYS = new Set(['mainBranches', 'releasePattern', 'releasePushEnv']);
const RELEASE_PATTERN_CHARS = /^[A-Za-z0-9._/*-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NONE_LABEL = 'None of these — stop';

/**
 * Recursively freeze plain data in place, mirroring dsh-llm's immutable
 * message invariant.
 * @param {unknown} value
 * @returns {unknown} the same reference, frozen.
 */
function deepFreeze(value) {
  if (value !== null && (typeof value === 'object' || Array.isArray(value))) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Build the immutable steered user message, matching dsh-llm's
 * `createUserMessage` shape.
 * @param {string} text the procedure prompt.
 * @returns {object} frozen user message.
 */
function createSteeredMessage(text) {
  return deepFreeze({
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
    id: randomUUID(),
  });
}

/** Uniform error text for caught exceptions. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Command error result shorthand. */
function fail(text) {
  return { kind: 'error', text };
}

/**
 * Validate and normalize the plugin config. Unknown keys fail at activation
 * so typos never silently disable a guard.
 *
 * @param {unknown} input raw row config; `{`}/`undefined` selects defaults.
 * @returns {Readonly<{ mainBranches: readonly string[], releasePattern: string, releasePushEnv: string }>}
 */
export function resolveConfig(input) {
  const raw = input === undefined || input === null ? {} : input;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('dsh-git-actions config must be an object');
  }
  const unknown = Object.keys(raw).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `dsh-git-actions config has unknown key(s) ${unknown.join(', ')} — allowed keys: ${[...CONFIG_KEYS].join(', ')}`,
    );
  }
  const mainBranches = raw.mainBranches === undefined ? ['main', 'master'] : raw.mainBranches;
  if (
    !Array.isArray(mainBranches)
    || mainBranches.length === 0
    || mainBranches.some((entry) => typeof entry !== 'string' || !isSafeShellBranchName(entry))
  ) {
    throw new TypeError(
      'dsh-git-actions config "mainBranches" must be a non-empty array of plain branch names (letters, digits, . _ / -)',
    );
  }
  const releasePattern = raw.releasePattern === undefined ? 'release/*' : raw.releasePattern;
  if (
    typeof releasePattern !== 'string'
    || !RELEASE_PATTERN_CHARS.test(releasePattern)
    || !releasePattern.includes('*')
  ) {
    throw new TypeError(
      'dsh-git-actions config "releasePattern" must be a glob over letters, digits, . _ / - and * (it must contain at least one *)',
    );
  }
  const releasePushEnv = raw.releasePushEnv === undefined ? 'DSH_ALLOW_RELEASE_PUSH' : raw.releasePushEnv;
  if (typeof releasePushEnv !== 'string' || !ENV_NAME.test(releasePushEnv)) {
    throw new TypeError('dsh-git-actions config "releasePushEnv" must be an environment variable name ([A-Za-z_][A-Za-z0-9_]*)');
  }
  return Object.freeze({
    mainBranches: Object.freeze([...new Set(mainBranches)]),
    releasePattern,
    releasePushEnv,
  });
}

/**
 * The plugin's Config schema (Standard Schema `~standard.validate`), the
 * exact protocol cordis `resolveConfig` calls. Dependency-free; configure
 * via the patch row.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: '@local/dsh-git-actions',
    validate(raw) {
      try {
        return { value: resolveConfig(raw) };
      } catch (error) {
        return {
          issues: [
            {
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    },
  },
};

/**
 * Ask the user through the session's question channel when one exists.
 * @returns {Promise<import('@deepseek-ai/dsh-user-questions/types').AskUserQuestionAnswer | null>} null when no channel answered.
 */
async function askUser(ctx, agent, signal, questions) {
  const channel = ctx.get('userQuestions');
  if (channel === undefined) return null;
  try {
    return await channel.ask({ questions, agent, signal });
  } catch (error) {
    ctx.logger?.warn?.('dsh-git-actions: interactive question failed: %o', error);
    return null;
  }
}

/** The selected label of one answered question item. */
function selectedLabel(answer, id) {
  const item = answer?.answers?.find((entry) => entry.id === id);
  const label = item?.selected?.[0];
  return label === undefined ? '' : label;
}

/** The custom text of one answered question item ('' when none). */
function customText(answer, id) {
  const item = answer?.answers?.find((entry) => entry.id === id);
  const custom = item?.custom;
  return typeof custom === 'string' ? custom.trim() : '';
}

/**
 * Resolve the services every command needs. Returns an error result when a
 * required service is missing from this composition.
 * @returns {{ ok: true, subprocess: object, workingDirectory: object } | { ok: false, result: { kind: 'error', text: string } }}
 */
function requireServices(ctx) {
  const subprocess = ctx.get('subprocess');
  const workingDirectory = ctx.get('workingDirectory');
  if (subprocess === undefined) {
    return { ok: false, result: fail('the subprocess service is not available in this composition — dsh-git-actions cannot run git') };
  }
  if (workingDirectory === undefined) {
    return { ok: false, result: fail('the workingDirectory service is not available in this composition — dsh-git-actions cannot resolve the session directory') };
  }
  return { ok: true, subprocess, workingDirectory };
}

/**
 * Host plugin entry: register the three commands against the optional
 * `commands` service; return the injected fiber's disposal as cleanup.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {unknown} config raw row config (already validated via `Config`).
 * @returns {() => void} cleanup.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const fiber = ctx.inject(['commands'], (commandCtx) => {
    const disposers = [];

    disposers.push(commandCtx.commands.register({
      name: 'draft-commit',
      description: 'Draft a commit message and present it for review; commit/push happen only when you ask',
      input: { hint: '[note]' },
      // The steered procedure prompt carries any note verbatim; recording
      // the raw input too would duplicate it in the session log.
      recordInput: false,
      handler: async ({ agent, rawInput = '', signal }) => {
        const services = requireServices(ctx);
        if (!services.ok) return services.result;
        const git = createGitKit(services.subprocess, signal);
        let cwd;
        try {
          cwd = await services.workingDirectory.ensure(agent, signal);
          if (!(await git.isGitRepo(cwd))) {
            return fail(`\`${cwd}\` is not inside a git work tree — open the session in a git repository first.`);
          }
          const branch = await git.currentBranch(cwd);
          if (branch === '') {
            return fail('HEAD is detached. Check out a branch first (e.g. /create-branch-from <base> <name>).');
          }
          if (isMainBranch(branch, resolved)) {
            return fail(
              `on protected main branch '${branch}' — dsh-git-actions never commits or pushes on ${resolved.mainBranches.join(', ')}. Create a work branch first (e.g. /create-branch-from ${branch} <name>).`,
            );
          }
          const release = isReleaseBranch(branch, resolved);
          const [status, stagedStat, recentSubjects, originExists, upstream, hooks] = await Promise.all([
            git.statusPorcelain(cwd).then(classifyStatus),
            git.stagedDiffStat(cwd),
            git.recentSubjects(cwd),
            git.originExists(cwd),
            git.upstreamInfo(cwd),
            git.hooksDirectory(cwd).then((dir) => inspectHooks(dir.dir)).catch(() => ({ 'pre-commit': false, 'pre-push': false })),
          ]);
          const prompt = buildDraftCommitPrompt(
            { cwd, branch, releaseBranch: release, originExists, upstream, status, stagedStat, recentSubjects, hooks },
            resolved,
            rawInput.trim(),
          );
          agent.steer(createSteeredMessage(prompt));
          return {
            kind: 'success',
            text: release
              ? `Draft run started on release branch '${branch}' — it presents the draft commit message and stops; commit and push happen only when you ask (a release push additionally needs an explicit confirmation and ${resolved.releasePushEnv}=1).`
              : `Draft run started on '${branch}' — it presents the draft commit message and stops; commit and push happen only when you ask.`,
          };
        } catch (error) {
          return fail(`git inspection failed: ${errorMessage(error)}`);
        }
      },
    }));

    disposers.push(commandCtx.commands.register({
      name: 'create-branch-from',
      description: 'Create (and switch to) a new branch from an existing one',
      input: { hint: '<source-branch> [new-branch]' },
      handler: async ({ agent, rawInput = '', signal }) => {
        const parsed = parseCreateBranchInput(rawInput);
        if (!parsed.ok) return fail(parsed.error);
        const services = requireServices(ctx);
        if (!services.ok) return services.result;
        const git = createGitKit(services.subprocess, signal);
        let cwd;
        const steerFallback = (situation, candidates) => {
          agent.steer(createSteeredMessage(buildCreateBranchFallbackPrompt(
            { cwd, sourceName: parsed.source, candidates, situation },
            resolved,
          )));
          return { kind: 'success', text: 'Continuing in the session — the interactive channel is unavailable.' };
        };
        try {
          cwd = await services.workingDirectory.ensure(agent, signal);
          if (!(await git.isGitRepo(cwd))) {
            return fail(`\`${cwd}\` is not inside a git work tree — open the session in a git repository first.`);
          }
          let source = await git.resolveSourceBranch(cwd, parsed.source);
          if (source === null) {
            const branches = await git.listBranches(cwd);
            const candidates = rankCandidates(branches, parsed.source);
            if (candidates.length === 0) {
              const names = branches.slice(0, 12).map((entry) => entry.name).join(', ');
              return fail(
                `branch '${parsed.source}' not found and no similar branch exists${names === '' ? ' (the repository lists no branches)' : `. Branches present: ${names}`}.`,
              );
            }
            const answer = await askUser(ctx, agent, signal, [{
              id: 'pick-source',
              header: 'Branch not found',
              question: `Branch '${parsed.source}' was not found. Which branch did you mean?`,
              detail: candidates.map((entry) => `${entry.name} (${entry.remote ? 'remote, on origin' : 'local'})`).join('\n'),
              options: [
                ...candidates.map((entry) => ({
                  label: entry.name,
                  description: entry.remote ? 'remote branch on origin' : 'local branch',
                })),
                { label: NONE_LABEL, description: 'Stop; do not create anything.' },
              ],
            }]);
            if (answer === null) return steerFallback('choose the source branch', candidates);
            const selected = selectedLabel(answer, 'pick-source');
            const typed = customText(answer, 'pick-source');
            if (selected === NONE_LABEL && typed === '') {
              return { kind: 'success', text: 'Cancelled — no branch created.' };
            }
            const chosen = selected !== '' && selected !== NONE_LABEL ? selected : typed;
            if (chosen === '') {
              return { kind: 'success', text: 'Cancelled — no branch selected.' };
            }
            const verified = await git.resolveSourceBranch(cwd, chosen);
            if (verified === null) {
              return fail(`branch '${chosen}' (chosen in the answer) could not be verified — re-run the command with an exact name.`);
            }
            source = verified;
          }
          let newName = parsed.newName;
          if (newName === null) {
            const answer = await askUser(ctx, agent, signal, [{
              id: 'new-name',
              header: 'New branch name',
              question: `Name for the new branch (created from ${source.display})?`,
            }]);
            if (answer === null) return steerFallback(`choose the new branch name (the source is resolved: ${source.display})`, []);
            const typed = customText(answer, 'new-name');
            if (typed === '') {
              return { kind: 'success', text: 'Cancelled — no branch name given.' };
            }
            newName = typed;
          }
          if (newName.startsWith('-')) {
            return fail(`invalid new branch name '${newName}': branch names cannot start with '-'`);
          }
          if (isMainBranch(newName, resolved)) {
            return fail(
              `refusing to create '${newName}': it is a protected main branch (${resolved.mainBranches.join(', ')}) and is never touched.`,
            );
          }
          const nameCheck = await git.checkBranchName(cwd, newName);
          if (!nameCheck.ok) return fail(`invalid new branch name: ${nameCheck.error}`);
          if (await git.refExists(cwd, `refs/heads/${newName}`)) {
            return fail(`branch '${newName}' already exists — pick another name, or switch to it directly.`);
          }
          if (isReleaseBranch(newName, resolved)) {
            const answer = await askUser(ctx, agent, signal, [{
              id: 'confirm-release',
              header: 'Release branch',
              question: `Create the release branch '${newName}' from ${source.display}? Release branches are protected: pushes need an explicit confirmation and ${resolved.releasePushEnv}=1.`,
              options: [
                { label: 'Create release branch', description: `Create '${newName}' now.` },
                { label: 'Cancel', description: 'Do not create anything.' },
              ],
            }]);
            if (answer === null) return steerFallback(`confirm creating the release branch '${newName}' from ${source.display}`, []);
            if (selectedLabel(answer, 'confirm-release') !== 'Create release branch') {
              return { kind: 'success', text: 'Cancelled — no branch created.' };
            }
          }
          const created = await git.createBranch(cwd, newName, source.ref);
          if (created.code !== 0) {
            return fail(`git checkout -b failed:\n${created.stderr.trim() || created.stdout.trim() || `exit code ${created.code}`}`);
          }
          return {
            kind: 'success',
            text: `Created and switched to '${newName}' from ${source.display} (${source.kind}).`,
          };
        } catch (error) {
          return fail(`git operation failed: ${errorMessage(error)}`);
        }
      },
    }));

    disposers.push(commandCtx.commands.register({
      name: 'setup-protect-branch-hook',
      description: 'Install git hooks protecting main and release/* branches (--remove to uninstall)',
      input: { hint: '[--remove]' },
      handler: async ({ agent, rawInput = '', signal }) => {
        const arg = rawInput.trim();
        if (arg !== '' && arg !== '--remove' && arg !== 'remove') {
          return fail('usage: /setup-protect-branch-hook [--remove]');
        }
        const services = requireServices(ctx);
        if (!services.ok) return services.result;
        const git = createGitKit(services.subprocess, signal);
        let cwd;
        try {
          cwd = await services.workingDirectory.ensure(agent, signal);
          if (!(await git.isGitRepo(cwd))) {
            return fail(`\`${cwd}\` is not inside a git work tree — open the session in a git repository first.`);
          }
          const { dir, source } = await git.hooksDirectory(cwd);
          if (arg !== '') {
            const results = await removeHooks(dir);
            const summary = results.map((entry) => `${entry.hook}: ${entry.action}`).join('; ');
            return { kind: 'success', text: `Protection hooks (${dir}): ${summary}` };
          }
          const describe = (results) => results
            .map((entry) => `${entry.hook}: ${entry.action}${entry.backup === undefined ? '' : ` (backup: ${entry.backup})`}`)
            .join('\n- ');
          const outcome = await installHooks(dir, resolved, async (hook, existing) => {
            const answer = await askUser(ctx, agent, signal, [{
              id: 'hook-conflict',
              header: `Existing ${hook} hook`,
              question: `A different '${hook}' hook already exists (${existing.split('\n').length} lines). Install the dsh-git-actions protection hook in its place?`,
              options: [
                {
                  label: 'Backup & install',
                  description: `The existing hook is kept as ${hook}.dsh-git-actions.bak and the protection hook takes over.`,
                },
                { label: 'Keep existing', description: `Leave the existing hook in place; skip '${hook}'.` },
                { label: 'Cancel', description: 'Stop; change nothing from this point on.' },
              ],
            }]);
            if (answer === null) return 'cancel';
            const selected = selectedLabel(answer, 'hook-conflict');
            if (selected === 'Backup & install') return 'replace';
            if (selected === 'Keep existing') return 'skip';
            return 'cancel';
          });
          if (outcome.status === 'cancelled') {
            const done = describe(outcome.results);
            return {
              kind: 'success',
              text: `Cancelled at '${outcome.hook}' — nothing further was changed.${done === '' ? '' : ` Completed before the cancel:\n- ${done}`}`,
            };
          }
          return {
            kind: 'success',
            text: [
              `Protection hooks installed in ${dir} (${source}).`,
              `- pre-commit: refuses commits on ${resolved.mainBranches.join(', ')} (detached HEAD passes).`,
              `- pre-push: refuses pushes updating ${resolved.mainBranches.map((b) => `refs/heads/${b}`).join(' or ')} on any remote — no override; ${resolved.releasePattern} pushes additionally need the explicit parameter ${resolved.releasePushEnv}=1 on that invocation.`,
              'Details:',
              `- ${describe(outcome.results)}`,
            ].join('\n'),
          };
        } catch (error) {
          return fail(`hook installation failed: ${errorMessage(error)}`);
        }
      },
    }));

    return () => {
      for (const dispose of disposers) dispose();
    };
  });
  return () => fiber.dispose();
}
