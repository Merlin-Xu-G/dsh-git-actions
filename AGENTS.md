# AGENTS.md

This repo holds `@local/dsh-git-actions`, a DSH (DeepSeek Harness) Host plugin bundle providing guarded git workflow commands.

## What this repo is for

The plugin automates the user's customized git workflow through session commands, with one non-negotiable safety model: **main branches are never modified** (no override exists), and **`release/*` origin changes always require explicit user confirmation plus the `DSH_ALLOW_RELEASE_PUSH=1` parameter**. Every change to this repo must preserve that model — it is enforced in three layers (command guards, procedure-prompt rules, git hooks), and weakening any layer is a bug.

## Layout

- `package.json` / `cordis.patch.yml` — bundle manifest and Loader patch (row `dsh-git-actions`, config defaults `{}`).
- `index.js` — plugin entry: Config schema (Standard Schema `~standard`), service resolution, and the three command handlers.
- `lib/branch.js` — pure logic: branch classification, input parsing, similar-branch ranking, status classification. No I/O.
- `lib/git.js` — git access over the Harness `subprocess` service (`ctx.subprocess`); argv is never shell-interpreted.
- `lib/hooks.js` — POSIX-sh `pre-commit` / `pre-push` script generation plus idempotent install/remove with foreign-hook backups.
- `lib/prompts.js` — steered procedure prompts (`/draft-commit` draft phase, create-branch fallback).
- `locale/` (en, zh), `icon.svg` — display metadata read by Plugin Manager / Settings.
- `test/test.mjs` — the test suite (run it; see below).
- `.tmp/` — scratch, gitignored.
- `README.md` — user-facing docs (commands, protection model, config, install).

## Commands and their semantics

- `/draft-commit [note]` — host-side verification (repo, branch, change facts), refuses to run on a main branch, then steers a **read-only** procedure: review changes, draft the commit message, print it as a fenced markdown block, end the turn. No staging, no commit, no push, no `ask_user_question` in the run — committing and pushing happen only as ordinary user prompts afterwards. Release branches keep their push rule as prompt text for that later moment.
- `/create-branch-from <source-branch> [new-branch]` — resolves the source host-side (local, `origin/x` shorthand, or explicit remote ref); on a miss, ranks similar branches and asks the user to pick; validates the new name (`git check-ref-format --branch`); refuses main names, confirms release names; then `git checkout -b`. When no question channel answers, it steers the fallback prompt instead of failing.
- `/setup-protect-branch-hook [--remove]` — installs/removes both hooks in the effective hooks directory (honors `core.hooksPath`); foreign hooks are backed up to `<hook>.dsh-git-actions.bak` only after the user agrees; `--remove` restores the plain backup when present.

## Hard rules for agents

- **Prompt style (all DSH plugin projects):** author every prompt as ONE multi-line template literal that reads as the document the model sees — never `lines.push(...)` arrays joined at the end. Conditional pieces are precomputed as small fragment literals above the main literal; markdown code spans are escaped (`` \` ``).
- **Commit message format** for this repo: first line `<type>: <brief description>` (feature/fix/docs/chore/refactor as applicable), then directly a change list, one sentence per bullet (`- change a`). Brief — no long body paragraphs.
- **Never commit or push without an explicit user instruction** — including in this repo. The protection hooks are typically installed here too (`pre-commit`/`pre-push` will refuse main work and parameter-less `release/*` pushes; do not bypass with `--no-verify`).
- Run the tests after every change: `node test/test.mjs` (when `node` is not on PATH, use the DSH-bundled node resolved via `load_workspace_dependencies`). All checks must pass; extend the suite when adding behavior.
- Keep the bundle **dependency-free** (Node built-ins and `lib/` modules only). When adding files or assets, update `exports` and `files` in `package.json` together.
- Hook scripts must stay plain POSIX sh with **LF-only endings** (CRLF breaks sh parsing) and must carry the `# dsh-git-actions:protect-branch v1` marker; config values baked into them are validated against safe charsets in `resolveConfig` — keep that invariant.
- Unknown config keys fail at activation on purpose; the config surface is exactly `mainBranches`, `releasePattern`, `releasePushEnv`. Overrides belong in the profile's own patch layer, not in the tracked default.
- No machine-specific absolute paths in tracked files.

## Installation and live reload

The desktop profile installs this directory as a linked bundle (pnpm junction: the repo *is* the installed package). Consequences:

- After editing plugin modules, a DSH host restart is required to load the new module generation — do not re-run `install_bundle` over the already-linked directory (it fails as `ambiguous-install`).
- The supported install path elsewhere is `plugin_manager` `install_bundle` with this directory as the target; never hand-write files under `$DSH_PROFILE_DIR` or `$DSH_HOME`.

## API contracts in use

Coded against the installed Harness (verify with the approval-free `cordis_inspect_list` / no-input catalog queries before changing): `ctx.commands.register({ name, description, input: { hint }, recordInput?, handler })` with handler `{ agent, rawInput, attachments, signal }` → `{ kind: 'success', text? } | { kind: 'error', text }`; `agent.steer()` accepts a hand-built frozen user message (`{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' }, id: randomUUID() }`); `ctx.get('subprocess' | 'workingDirectory' | 'userQuestions')` for the optional services, degrading gracefully when absent.
