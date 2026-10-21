/**
 * Steered procedure prompts for @local/dsh-git-actions.
 *
 * `/draft-commit` delegates the language work (drafting the commit message)
 * to the session's agent: the command gathers deterministic git facts
 * host-side, then steers one procedure prompt carrying those facts. The run
 * is read-only — it reviews the changes, drafts the message, prints it as a
 * markdown block, and returns control to the user; committing and pushing
 * happen later, only when the user asks for them in conversation.
 *
 * Style rule (applies to every DSH plugin project): each prompt is authored
 * as ONE multi-line template literal that reads as the document the model
 * sees — never as an array of `lines.push(...)` fragments joined at the end.
 * Varying pieces (conditional paragraphs, option lists) are precomputed as
 * small fragment literals above the main literal and interpolated in.
 * Markdown code spans are escaped (\`) inside the literals.
 */

import { summarizeStatus } from './branch.js';

/**
 * Fenced code block, only when the content is non-empty.
 * @param {string} content
 * @returns {string}
 */
function fence(content) {
  const trimmed = content.trim();
  return trimmed === '' ? '(empty)' : `\`\`\`\n${trimmed}\n\`\`\``;
}

/**
 * @typedef {Object} DraftCommitFacts
 * @property {string} cwd
 * @property {string} branch
 * @property {boolean} releaseBranch
 * @property {boolean} originExists
 * @property {{ name: string, ahead: number, behind: number } | null} upstream
 * @property {{ staged: string[], unstaged: string[], untracked: string[] }} status
 * @property {string} stagedStat
 * @property {string[]} recentSubjects
 * @property {{ 'pre-commit': boolean, 'pre-push': boolean }} hooks
 */

/**
 * Build the /draft-commit procedure prompt (draft phase only).
 *
 * @param {DraftCommitFacts} facts verified host-side by the command.
 * @param {{ mainBranches: readonly string[], releasePattern: string, releasePushEnv: string }} resolved
 * @param {string} note optional free-form user note ('' when absent).
 * @returns {string} markdown prompt.
 */
export function buildDraftCommitPrompt(facts, resolved, note) {
  const mainList = resolved.mainBranches.join(', ');

  // -- interpolated fragments (conditional pieces stay out of the literal) --
  const branchLine = facts.releaseBranch
    ? `- Current branch: \`${facts.branch}\` (**release branch** — later pushes need an explicit confirmation and the push parameter)`
    : `- Current branch: \`${facts.branch}\``;
  const upstreamLine = facts.upstream === null
    ? '- Upstream: none (this branch does not track a remote branch yet)'
    : `- Upstream: \`${facts.upstream.name}\` (ahead ${facts.upstream.ahead}, behind ${facts.upstream.behind})`;
  const stagedStat = facts.stagedStat.trim() === '' ? '(nothing staged)' : fence(facts.stagedStat);
  const subjects = facts.recentSubjects.length === 0 ? '(no commits yet)' : fence(facts.recentSubjects.join('\n'));
  const rule4 = facts.releaseBranch
    ? `4. This is a **release branch** (\`${resolved.releasePattern}\`): when the user later asks to push, that origin modification always needs an explicit user confirmation and the parameter \`${resolved.releasePushEnv}=1\` on that single invocation.`
    : `4. This is not a release branch (\`${resolved.releasePattern}\`). If a later user request targets a matching branch, apply the release rule from that moment on.`;
  const scopeStep = facts.status.staged.length > 0
    ? 'Changes are already staged — the draft covers the staged set. Inspect the staged diff (`git diff --cached`, then `git diff --cached -- <path>` for detail). Unstaged and untracked paths are NOT part of the draft; report them as leftovers.'
    : 'Nothing is staged — the draft covers the full working-tree change set (unstaged and untracked). Review the diffs (`git diff`, `git diff -- <path>`; for untracked files, read the files), and report the exact `git add <paths>` command that would stage precisely the covered paths.';
  const followUpLine = facts.releaseBranch
    ? `- One line for what happens next: committing and pushing happen only on the user's instruction — a release-branch push additionally needs an explicit confirmation and \`${resolved.releasePushEnv}=1\` on that invocation.`
    : "- One line for what happens next: committing and pushing happen only on the user's instruction.";

  return `# dsh-git-actions draft-commit run (draft phase)

You are executing the draft phase of the guarded commit workflow for the repository at \`${facts.cwd}\`: inspect the changes, draft the commit message, present it, and return control to the user. This run is **read-only** — never run \`git add\`, \`git commit\`, \`git push\`, or any other state-changing git command, and ask no questions. The git facts below were verified by the command moments ago — trust them over re-derivation.

User note for this run: ${note === '' ? '(none)' : note}

## Verified context

- Working directory: \`${facts.cwd}\`
${branchLine}
- Origin remote: ${facts.originExists ? 'exists' : 'absent'}
${upstreamLine}
- Changes — ${summarizeStatus(facts.status)}
- Staged diff stat:

${stagedStat}

- Recent commit subjects (style reference):

${subjects}

- Protection hooks installed in this repo: pre-commit ${facts.hooks['pre-commit'] ? 'yes' : 'no'}, pre-push ${facts.hooks['pre-push'] ? 'yes' : 'no'}

## Absolute rules

1. This run is read-only: no staging, no commit, no push, no \`ask_user_question\` — present the result and end your turn.
2. Never draft for a main branch (${mainList}): the command already refused to run on one; if you observe that the checked-out branch changed mid-run, stop and report instead of drafting.
3. Base the draft strictly on changes you actually reviewed, and list every path the draft covers.
${rule4}

## Step 1 — Review the changes

${scopeStep}

If the working tree is completely clean, say so and stop.

## Step 2 — Draft the commit message

Keep it brief. The first line is \`<type>: <brief description>\`, where the type names the change kind (feature for new capabilities, fix for fixes, docs/chore/refactor as applicable) and the description is one short phrase. Directly below it, list the changes — one sentence per point:

\`\`\`
feature/bugfix/docs/<any others actions>: <brief description>
- change a
- change b
\`\`\`

Match the type to the actual change, keep each bullet to one sentence, and add no long body paragraphs.

## Step 3 — Present the draft and return to the user

Print the complete commit message as one fenced markdown code block, exactly as it should be passed to \`git commit\` (type-prefixed first line, then the change list). Follow it with a short report:

- branch: \`${facts.branch}\`
- the paths the draft covers, and the exact \`git add <paths>\` command when nothing was staged
- paths left out (unstaged or untracked while a staged set exists)
${followUpLine}

Then end your turn: do not commit, do not push, do not stage, do not ask anything further.

## When the user later asks to commit

Before committing, run \`git status\` and confirm the tree still matches this draft exactly: the staged set equals the covered paths, and no non-staged change has appeared since (unstaged or untracked). When anything differs, show the user the exact difference and get their explicit confirmation before staging or committing — never sweep unexpected edits into the commit, and never leave a covered path unstaged silently.
`;
}

/**
 * @typedef {Object} DraftPrFacts
 * @property {string} cwd
 * @property {string} branch
 * @property {string} baseName
 * @property {string} baseRef
 * @property {number} ahead
 * @property {number} behind
 * @property {string[]} commits `<short-hash> <subject>` lines, oldest first.
 * @property {string} diffStat
 * @property {boolean} originExists
 * @property {boolean} releaseHead
 * @property {boolean} releaseBase
 */

/**
 * Build the /draft-pr procedure prompt (draft phase only).
 *
 * @param {DraftPrFacts} facts verified host-side by the command.
 * @param {{ mainBranches: readonly string[], releasePattern: string, releasePushEnv: string }} resolved
 * @param {string} note optional free-form user note ('' when absent).
 * @returns {string} markdown prompt.
 */
export function buildDraftPrPrompt(facts, resolved, note) {
  const mainList = resolved.mainBranches.join(', ');

  // -- interpolated fragments (conditional pieces stay out of the literal) --
  const headLine = facts.releaseHead
    ? `- PR head branch: \`${facts.branch}\` (**release branch**)`
    : `- PR head branch: \`${facts.branch}\``;
  const baseLine = facts.releaseBase
    ? `- PR base branch: \`${facts.baseName}\` (**release branch** — merging modifies a protected release branch on origin)`
    : `- PR base branch: \`${facts.baseName}\` (detected from the branch's upstream or origin's default)`;
  const rule4 = facts.releaseHead || facts.releaseBase
    ? `4. This PR ${facts.releaseHead ? 'heads from' : 'targets'} a **release branch** (\`${resolved.releasePattern}\`): when the user later asks to create or merge it, that origin modification needs an explicit user confirmation.`
    : `4. Neither side of this PR is a release branch (\`${resolved.releasePattern}\`). If that changes, apply the release rule from that moment on.`;
  const commits = fence(facts.commits.join('\n'));
  const diffStat = facts.diffStat.trim() === '' ? '(no content difference)' : fence(facts.diffStat);
  const nextLine = facts.releaseHead || facts.releaseBase
    ? `- One line for what happens next: creating the PR happens only on the user's instruction (\`gh pr create --base ${facts.baseName} --head ${facts.branch} --title '<title>' --body-file <file>\`) — this PR touches a protected release branch, so creation and merge need an explicit confirmation.`
    : `- One line for what happens next: creating the PR happens only on the user's instruction (\`gh pr create --base ${facts.baseName} --head ${facts.branch} --title '<title>' --body-file <file>\`).`;

  return `# dsh-git-actions draft-pr run (draft phase)

You are executing the draft phase of the PR workflow for the repository at \`${facts.cwd}\`: review what the pull request from \`${facts.branch}\` into \`${facts.baseName}\` would contain, draft its title and body, present them, and return control to the user. This run is **read-only** — never run \`git push\`, \`gh pr create\`, or any other state-changing git or gh command, and ask no questions. The git facts below were verified by the command moments ago — trust them over re-derivation.

User note for this run: ${note === '' ? '(none)' : note}

## Verified context

- Working directory: \`${facts.cwd}\`
${headLine}
${baseLine}
- Origin remote: ${facts.originExists ? 'exists' : 'absent'}
- Ahead/behind vs base (merge-base): ahead ${facts.ahead}, behind ${facts.behind}
- Commits the PR would carry (oldest first):

${commits}

- Diffstat vs base:

${diffStat}

## Absolute rules

1. This run is read-only: no push, no PR creation, no staging, no \`ask_user_question\` — present the result and end your turn. Read-only inspection (\`git diff\`, \`git log\`, \`git show\`, \`gh pr view\`, \`gh pr list\`) is allowed.
2. Never draft a PR from a main branch (${mainList}): the command already refused to run on one; if you observe that the checked-out branch changed mid-run, stop and report instead of drafting.
3. Base the draft strictly on commits and diffs you actually reviewed, and list them.
${rule4}
5. When an open PR already exists for \`${facts.branch}\` (check \`gh pr view\` if gh is available), say so and draft an update to its title and body instead of a new-PR draft.

## Step 1 — Review the PR content

Inspect \`git diff ${facts.baseName}...HEAD\` (and \`-- <path>\` for detail) and the listed commits' full messages (\`git show <hash>\`). Skim recently merged PR titles (\`gh pr list --state merged --limit 5\`) when gh is available, for the repository's PR style.

## Step 2 — Draft the title and body

Keep both brief and match the repository's commit convention. Title: one \`<type>: <brief description>\` line. Body: a \`## Summary\` list of the changes — one sentence per point, mirroring the branch's commit bullets — plus a \`## Verification\` line stating what was checked. No long paragraphs.

## Step 3 — Present the draft and return to the user

Print the exact title in one fenced block, then the exact body in a second fenced block. Follow with a short report:

- head → base: \`${facts.branch}\` → \`${facts.baseName}\` (ahead ${facts.ahead}, behind ${facts.behind})
- the commits and files the PR covers
- existing-PR status (checked via gh, or not checked because gh is unavailable)
${nextLine}

Then end your turn: do not push, do not create anything, do not ask anything further.

## When the user later asks to create the PR

Before creating it, re-run \`git status\` and \`git log ${facts.baseName}..HEAD\` and confirm the branch still matches this draft: same commits, same base, no new non-staged work. When anything differs, show the user the exact difference and get their explicit confirmation before creating — never push extra commits and never open the PR against a silently changed base.
`;
}

/**
 * @typedef {Object} CreateBranchFallbackFacts
 * @property {string} cwd
 * @property {string} sourceName the branch name the user typed.
 * @property {{ name: string, remote: boolean }[]} candidates similar branches ('' flows use an empty list).
 * @property {string} situation what remains to resolve.
 */

/**
 * Build the fallback prompt for /create-branch-from when the interactive
 * question channel is unavailable: the agent completes the same flow with
 * ask_user_question and the same guards.
 *
 * @param {CreateBranchFallbackFacts} facts
 * @param {{ mainBranches: readonly string[], releasePattern: string }} resolved
 * @returns {string} markdown prompt.
 */
export function buildCreateBranchFallbackPrompt(facts, resolved) {
  const candidates = facts.candidates.length === 0
    ? '(none)'
    : `\n${facts.candidates.map((entry) => `  - \`${entry.name}\` (${entry.remote ? 'remote branch on origin' : 'local branch'})`).join('\n')}`;

  return `# dsh-git-actions create-branch-from (interactive fallback)

The /create-branch-from command verified the repository at \`${facts.cwd}\` but could not reach the interactive question channel, so it handed the remaining interactive steps to you. Complete them with ask_user_question, honoring the same guards. Resolve nothing the user has not confirmed.

- Requested source branch: \`${facts.sourceName}\` (not found as typed)
- Similar branches found by the command: ${candidates}

Remaining to resolve: ${facts.situation}

Guards (absolute):

- The new branch name must not be one of the protected main branches (${resolved.mainBranches.join(', ')}) and must not already exist.
- When the chosen name matches \`${resolved.releasePattern}\`, tell the user release branches are protected (origin pushes need an explicit confirmation and a push parameter) and get an explicit go-ahead before creating it.
- Validate the final name with \`git check-ref-format --branch <name>\`.

Then create it with \`git checkout -b <new-branch> <source-ref>\` (use the exact ref as listed: a remote candidate is its full \`origin/...\` name) and report the result. If the user declines any step, stop cleanly and say so.
`;
}
