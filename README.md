# dsh-git-actions

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin bundle (`@local/dsh-git-actions`) that automates a guarded git workflow with three session commands. It never touches `main`, and every `release/*` origin change is explicitly confirmed.

## Commands

| Command | What it does |
|---|---|
| `/draft-commit [note]` | Inspects the repository host-side, refuses to run on a protected main branch, then runs a **read-only** draft phase in the session: review the changes, draft the commit message, and print it as a markdown block — then returns to you. Committing and pushing are done by ordinary prompts when you ask. |
| `/create-branch-from <source-branch> [new-branch]` | Verifies the source branch exists (local or `origin/…`). If the name misses, ranks similar branches and **asks which one you meant**. Validates the new name, refuses main-branch names, confirms release-branch names, then creates and switches to the branch. |
| `/setup-protect-branch-hook [--remove]` | Installs (or removes) `pre-commit` / `pre-push` git hooks that enforce the protection rules inside git itself. Existing foreign hooks are backed up to `<hook>.dsh-git-actions.bak`, never silently destroyed. |

## Protection model

Three layers, each enforcing the same two rules — **main branches (`main`, `master` by default) are never modified**, and **`release/*` origin changes always require an explicit user action**:

1. **Command guards (host-side, deterministic)** — `/draft-commit` refuses to run while a main branch is checked out; `/create-branch-from` refuses to create a main branch and asks before creating a `release/*` branch. Branch classification happens in the command handler, before any agent turn.
2. **Procedure prompts** — the `/draft-commit` workflow is read-only: it reviews, drafts, and presents the message, then returns control; committing and pushing happen only when you ask for them, and for `release/*` branches a later push still requires an explicit confirmation and the per-invocation parameter.
3. **Git hooks** (installed by `/setup-protect-branch-hook`) — enforcement that survives outside DSH:
   - `pre-commit` refuses commits on main branches (detached HEAD passes, so rebase etc. still work).
   - `pre-push` refuses any push updating a main branch ref on any remote — **there is no override** — and refuses `release/*` pushes unless the push carries the explicit parameter:

     ```sh
     DSH_ALLOW_RELEASE_PUSH=1 git push            # POSIX shells
     # PowerShell:
     $env:DSH_ALLOW_RELEASE_PUSH='1'; try { git push origin <branch> } finally { Remove-Item Env:DSH_ALLOW_RELEASE_PUSH -ErrorAction SilentlyContinue }
     ```

## Configuration

Defaults live in [`cordis.patch.yml`](cordis.patch.yml); override them in your profile's own patch layer (an override replaces `config` wholesale — restate every field):

```yaml
- id: dsh-git-actions
  name: '@local/dsh-git-actions'
  config:
    mainBranches: [main, master]      # branches never touched
    releasePattern: 'release/*'       # '*' matches any run of characters
    releasePushEnv: DSH_ALLOW_RELEASE_PUSH   # explicit release-push parameter
```

Unknown keys fail at plugin activation rather than being ignored.

## Install

From this repository's directory (or any absolute path to it), in a DSH session with `plugin_manager` access:

```
plugin_manager: install_bundle  target: C:\...\dsh-git-actions
```

The bundle has no dependencies (host services only). After installation the three commands appear in the session composer's command list for every session in that profile.

## Development notes

- `index.js` registers the commands (`ctx.commands.register`) and hosts the handlers; `lib/branch.js` holds the pure guards/scoring; `lib/git.js` wraps `ctx.subprocess` (argv is never shell-interpreted); `lib/hooks.js` renders and installs the POSIX-sh hooks (LF endings); `lib/prompts.js` builds the steered procedure prompts.
- Interactive confirmations go through the session's `userQuestions` channel; when no channel answers (UI-less profiles), the commands steer the session's agent to finish the interaction instead of failing.
- `/draft-commit` delegates the actual drafting/commit/push to the agent under the session's approval policy — the command itself only reads git state and steers.
