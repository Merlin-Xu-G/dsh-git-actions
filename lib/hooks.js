/**
 * Branch-protection git hooks for @local/dsh-git-actions: script content,
 * idempotent install (foreign hooks are backed up, never silently destroyed),
 * and removal that restores the most recent backup when one exists.
 *
 * The hooks are plain POSIX sh so Git for Windows (which runs hooks through
 * its bundled sh) and every Unix work the same way. Scripts are written with
 * LF endings only — CRLF breaks sh parsing.
 */

import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Marker line identifying hooks owned by this plugin. */
export const HOOK_MARKER = '# dsh-git-actions:protect-branch v1';

/** The hooks this plugin owns. */
export const PROTECTED_HOOKS = /** @type {const} */ (['pre-commit', 'pre-push']);

/** Simple branch-name check used by config validation (mirror in shell arms). */
const BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;

/**
 * Validate that a configured branch name is safe to bake into a shell script.
 * @param {string} name
 * @returns {boolean}
 */
export function isSafeShellBranchName(name) {
  return BRANCH_NAME.test(name) && !name.startsWith('-') && !name.includes('..');
}

/**
 * Render the pre-commit hook: refuses commits on protected main branches.
 * Commits on a detached HEAD pass (rebase and similar operations need them).
 *
 * @param {{ mainBranches: readonly string[] }} resolved
 * @returns {string} script content (LF endings).
 */
export function preCommitScript(resolved) {
  const arms = resolved.mainBranches.join('|');
  return [
    '#!/bin/sh',
    HOOK_MARKER,
    `# Refuses commits on protected main branches: ${resolved.mainBranches.join(', ')}.`,
    '# Installed by /setup-protect-branch-hook (DSH plugin @local/dsh-git-actions).',
    '# Remove with /setup-protect-branch-hook --remove (or delete this file).',
    'branch=$(git branch --show-current 2>/dev/null || true)',
    '[ -n "$branch" ] || exit 0',
    'case "$branch" in',
    `  ${arms})`,
    "    echo \"dsh-git-actions: refusing commit on protected main branch '$branch'.\" >&2",
    '    echo "Switch to a work branch first: git checkout -b <name> <start-point>" >&2',
    '    exit 1',
    '    ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n');
}

/**
 * Render the pre-push hook: origin guard for main and release branches.
 *
 * - A push updating any main branch ref on the remote is always refused —
 *   there is no override.
 * - A push updating a release branch ref is refused unless the explicit
 *   parameter (the configured env variable) equals 1 for that invocation.
 * - Branch deletions are matched too: the remote ref name decides.
 *
 * @param {{ mainBranches: readonly string[], releasePattern: string, releasePushEnv: string }} resolved
 * @returns {string} script content (LF endings).
 */
export function prePushScript(resolved) {
  const mainArms = resolved.mainBranches.map((branch) => `refs/heads/${branch}`).join('|');
  const releaseArm = `refs/heads/${resolved.releasePattern}`;
  return [
    '#!/bin/sh',
    HOOK_MARKER,
    '# Push guard for protected branches:',
    `#   ${resolved.mainBranches.join(', ')} — never pushed; no override exists.`,
    `#   ${resolved.releasePattern} — pushed only with the explicit parameter ${resolved.releasePushEnv}=1.`,
    `#   Example: ${resolved.releasePushEnv}=1 git push   (prefix assignment in POSIX shells)`,
    '# Installed by /setup-protect-branch-hook (DSH plugin @local/dsh-git-actions).',
    'remote="${1:-origin}"',
    'while read local_ref local_sha remote_ref remote_sha; do',
    '  [ -n "$remote_ref" ] || continue',
    '  case "$remote_ref" in',
    `    ${mainArms})`,
    '      echo "dsh-git-actions: push to main branch $remote_ref on \\"$remote\\" refused (protected, no override)." >&2',
    '      exit 1',
    '      ;;',
    `    ${releaseArm})`,
    `      if [ "\${${resolved.releasePushEnv}:-0}" != "1" ]; then`,
    '        echo "dsh-git-actions: push to release branch $remote_ref on \\"$remote\\" refused." >&2',
    `        echo "Release pushes require the explicit parameter: ${resolved.releasePushEnv}=1 git push" >&2`,
    '        exit 1',
    '      fi',
    '      ;;',
    '  esac',
    'done',
    'exit 0',
    '',
  ].join('\n');
}

/**
 * Pick the next free backup path for a hook (`<hook>.dsh-git-actions.bak`,
 * then timestamped variants so no backup is ever overwritten).
 * @param {string} dir hooks directory.
 * @param {string} hook hook file name.
 * @returns {Promise<string>} unused backup path.
 */
async function nextBackupPath(dir, hook) {
  const plain = join(dir, `${hook}.dsh-git-actions.bak`);
  try {
    await access(plain);
  } catch {
    return plain;
  }
  return join(dir, `${hook}.dsh-git-actions.${Date.now()}.bak`);
}

/**
 * Install both protection hooks.
 *
 * @param {string} dir hooks directory (created when missing).
 * @param {{ mainBranches: readonly string[], releasePattern: string, releasePushEnv: string }} resolved
 * @param {(hook: string, existing: string) => Promise<'replace' | 'skip' | 'cancel'>} decideConflict
 *        asked when a foreign (non-plugin) hook already occupies the path.
 * @returns {Promise<{ status: 'done' | 'cancelled', hook?: string, results: { hook: string, action: string, backup?: string }[] }>}
 */
export async function installHooks(dir, resolved, decideConflict) {
  const results = [];
  await mkdir(dir, { recursive: true });
  for (const hook of PROTECTED_HOOKS) {
    const path = join(dir, hook);
    const existing = await readFile(path, 'utf8').catch(() => null);
    if (existing !== null && !existing.includes(HOOK_MARKER)) {
      const decision = await decideConflict(hook, existing);
      if (decision === 'cancel') return { status: 'cancelled', hook, results };
      if (decision === 'skip') {
        results.push({ hook, action: 'skipped-existing' });
        continue;
      }
      const backup = await nextBackupPath(dir, hook);
      await rename(path, backup);
      results.push({ hook, action: 'backed-up', backup });
    }
    const script = hook === 'pre-commit' ? preCommitScript(resolved) : prePushScript(resolved);
    await writeFile(path, script, { mode: 0o755 });
    await chmod(path, 0o755).catch(() => {});
    const written = await readFile(path, 'utf8');
    if (written !== script) throw new Error(`verification failed: ${path} does not match the generated hook`);
    results.push({ hook, action: existing === null ? 'installed' : 'reinstalled' });
  }
  return { status: 'done', results };
}

/**
 * Remove the protection hooks this plugin owns. Foreign hooks are untouched;
 * the plain backup is restored when present.
 *
 * @param {string} dir hooks directory.
 * @returns {Promise<{ hook: string, action: string }[]>}
 */
export async function removeHooks(dir) {
  const results = [];
  for (const hook of PROTECTED_HOOKS) {
    const path = join(dir, hook);
    const existing = await readFile(path, 'utf8').catch(() => null);
    if (existing === null) {
      results.push({ hook, action: 'absent' });
      continue;
    }
    if (!existing.includes(HOOK_MARKER)) {
      results.push({ hook, action: 'foreign-kept' });
      continue;
    }
    const backup = join(dir, `${hook}.dsh-git-actions.bak`);
    const backupExists = await readFile(backup, 'utf8').catch(() => null) !== null;
    if (backupExists) {
      await unlink(path);
      await rename(backup, path);
      results.push({ hook, action: 'restored-backup' });
    } else {
      await unlink(path);
      results.push({ hook, action: 'removed' });
    }
  }
  return results;
}

/**
 * Read both protection hooks and report whether this plugin owns them.
 * @param {string} dir hooks directory.
 * @returns {Promise<{ 'pre-commit': boolean, 'pre-push': boolean }>} marker presence per hook.
 */
export async function inspectHooks(dir) {
  const report = { 'pre-commit': false, 'pre-push': false };
  for (const hook of PROTECTED_HOOKS) {
    const existing = await readFile(join(dir, hook), 'utf8').catch(() => null);
    report[hook] = existing !== null && existing.includes(HOOK_MARKER);
  }
  return report;
}
