/**
 * Host-side git access for @local/dsh-git-actions, built on the Harness
 * `subprocess` service (`ctx.subprocess`): argv is never shell-interpreted,
 * every call is fully specified, and output is collected through bounded
 * in-memory tails per the service contract.
 *
 * Contracts used (verified against the installed Harness):
 * - `subprocess.resolveExecutable(command): Promise<string>`
 * - `subprocess.spawn({ argv, cwd, stdio: { stdin, stdout, stderr }, graceMs,
 *    signal }): SubprocessHandle` — `handle.done` resolves with
 *    `{ exitCode, signal }` (rejects on spawn failure or abort);
 *    `handle.collected.stdout?.readFrom(0).text` reads the collected tail.
 */

import { isAbsolute, join } from 'node:path';
import { parseBranchRefs } from './branch.js';

const STDOUT_MAX_BYTES = 1024 * 1024;
const STDERR_MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * @typedef {{ code: number, signal: string | null, stdout: string, stderr: string }} GitResult
 */

/**
 * Build the git kit bound to one command invocation.
 *
 * @param {import('@deepseek-ai/dsh-subprocess').SubprocessRuntime} subprocess host subprocess service.
 * @param {AbortSignal | undefined} parentSignal the command invocation's cancellation signal.
 * @returns git command helpers bound to that service and signal.
 */
export function createGitKit(subprocess, parentSignal) {
  let gitExecutable;

  const resolveGit = async () => {
    gitExecutable ??= await subprocess.resolveExecutable('git');
    return gitExecutable;
  };

  /**
   * Run one git command, collecting stdout/stderr tails.
   * @param {string} cwd working directory for the call.
   * @param {readonly string[]} args git arguments (never shell-interpreted).
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {Promise<GitResult>}
   */
  async function run(cwd, args, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const parent = options.signal ?? parentSignal;
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(parent.reason);
    if (parent) {
      if (parent.aborted) controller.abort(parent.reason);
      else parent.addEventListener('abort', abortFromParent, { once: true });
    }
    const timer = timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error(`git ${args[0]} timed out after ${timeoutMs} ms`)), timeoutMs)
      : undefined;
    try {
      const executable = await resolveGit();
      const handle = subprocess.spawn({
        argv: [executable, ...args],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: STDOUT_MAX_BYTES },
          stderr: { maxBytes: STDERR_MAX_BYTES },
        },
        graceMs: 5_000,
        signal: controller.signal,
      });
      const done = await handle.done;
      const stdout = handle.collected?.stdout ? handle.collected.stdout.readFrom(0).text : '';
      const stderr = handle.collected?.stderr ? handle.collected.stderr.readFrom(0).text : '';
      return { code: done.exitCode, signal: done.signal ?? null, stdout, stderr };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (parent) parent.removeEventListener('abort', abortFromParent);
    }
  }

  return {
    run,

    /** `true` when cwd is inside a git work tree. */
    async isGitRepo(cwd) {
      const result = await run(cwd, ['rev-parse', '--is-inside-work-tree']);
      return result.code === 0 && result.stdout.trim() === 'true';
    },

    /** Current branch name ('' when detached). */
    async currentBranch(cwd) {
      const result = await run(cwd, ['branch', '--show-current']);
      return result.code === 0 ? result.stdout.trim() : '';
    },

    /**
     * List local branches and origin's remote branches.
     * @returns {Promise<{ name: string, remote: boolean }[]>}
     */
    async listBranches(cwd) {
      const result = await run(cwd, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin']);
      if (result.code !== 0) return [];
      return parseBranchRefs(result.stdout);
    },

    /** `true` when the exact ref exists. */
    async refExists(cwd, ref) {
      const result = await run(cwd, ['rev-parse', '--verify', '--quiet', ref]);
      return result.code === 0;
    },

    /**
     * Resolve a user-typed branch name to a concrete ref: local branch,
     * explicit remote-tracking ref (`origin/x`), or `origin/x` shorthand.
     * @returns {Promise<{ kind: 'local' | 'remote', ref: string, display: string } | null>}
     */
    async resolveSourceBranch(cwd, name) {
      const local = await run(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
      if (local.code === 0) return { kind: 'local', ref: `refs/heads/${name}`, display: name };
      const explicit = await run(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/${name}`]);
      if (explicit.code === 0) return { kind: 'remote', ref: `refs/remotes/${name}`, display: name };
      const origin = await run(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]);
      if (origin.code === 0) return { kind: 'remote', ref: `refs/remotes/origin/${name}`, display: `origin/${name}` };
      return null;
    },

    /** Raw `git status --porcelain`. */
    async statusPorcelain(cwd) {
      const result = await run(cwd, ['status', '--porcelain']);
      return result.code === 0 ? result.stdout : '';
    },

    /** Stat of the staged changes ('' when nothing is staged). */
    async stagedDiffStat(cwd) {
      const result = await run(cwd, ['diff', '--cached', '--stat']);
      return result.code === 0 ? result.stdout.trim() : '';
    },

    /** Up to 8 recent commit subjects for style reference. */
    async recentSubjects(cwd) {
      const result = await run(cwd, ['log', '-n', '8', '--format=%s']);
      if (result.code !== 0) return [];
      return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    },

    /** `true` when a remote named origin exists. */
    async originExists(cwd) {
      const result = await run(cwd, ['remote']);
      if (result.code !== 0) return false;
      return result.stdout.split('\n').map((line) => line.trim()).includes('origin');
    },

    /**
     * Upstream tracking info for HEAD.
     * @returns {Promise<{ name: string, ahead: number, behind: number } | null>}
     */
    async upstreamInfo(cwd) {
      const upstream = await run(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
      if (upstream.code !== 0) return null;
      const name = upstream.stdout.trim();
      const counts = await run(cwd, ['rev-list', '--left-right', '--count', `${name}...HEAD`]);
      let ahead = 0;
      let behind = 0;
      if (counts.code === 0) {
        const match = /^(\d+)\s+(\d+)$/.exec(counts.stdout.trim());
        if (match) {
          behind = Number(match[1]);
          ahead = Number(match[2]);
        }
      }
      return { name, ahead, behind };
    },

    /**
     * Validate a candidate branch name with git itself
     * (`git check-ref-format --branch`).
     * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
     */
    async checkBranchName(cwd, name) {
      const result = await run(cwd, ['check-ref-format', '--branch', name]);
      if (result.code === 0) return { ok: true };
      return {
        ok: false,
        error: result.stderr.trim() || `'${name}' is not a valid branch name`,
      };
    },

    /**
     * Create a branch and switch to it (`git checkout -b <name> <startRef>`).
     * @returns {Promise<GitResult>}
     */
    async createBranch(cwd, name, startRef) {
      return run(cwd, ['checkout', '-b', name, startRef]);
    },

    /** Repository top level ('' on failure). */
    async topLevel(cwd) {
      const result = await run(cwd, ['rev-parse', '--show-toplevel']);
      return result.code === 0 ? result.stdout.trim() : '';
    },

    /**
     * Resolve the effective hooks directory, honoring `core.hooksPath`.
     * @returns {Promise<{ dir: string, source: 'core.hooksPath' | 'git-dir' }>}
     */
    async hooksDirectory(cwd) {
      const configured = await run(cwd, ['config', '--get', 'core.hooksPath']);
      if (configured.code === 0 && configured.stdout.trim() !== '') {
        const raw = configured.stdout.trim();
        if (isAbsolute(raw)) return { dir: raw, source: 'core.hooksPath' };
        const root = await this.topLevel(cwd);
        if (root !== '') return { dir: join(root, raw), source: 'core.hooksPath' };
      }
      const absolute = await run(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
      if (absolute.code === 0 && absolute.stdout.trim() !== '') {
        return { dir: absolute.stdout.trim().replace(/[\/]+$/, ''), source: 'git-dir' };
      }
      // --path-format=absolute needs git >= 2.31; fall back to resolving the
      // (possibly relative) git common dir against the work-tree top level.
      const common = await run(cwd, ['rev-parse', '--git-common-dir']);
      const root = await this.topLevel(cwd);
      const base = root !== '' ? root : cwd;
      const commonDir = common.code === 0 && common.stdout.trim() !== ''
        ? common.stdout.trim()
        : '.git';
      const absoluteCommon = isAbsolute(commonDir) ? commonDir : join(base, commonDir);
      return { dir: join(absoluteCommon, 'hooks'), source: 'git-dir' };
    },
  };
}

/**
 * @typedef {ReturnType<typeof createGitKit>} GitKit
 */
