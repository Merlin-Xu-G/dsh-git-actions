/**
 * Pure branch logic for @local/dsh-git-actions: config-validated guards,
 * command-argument parsing, and similar-branch candidate ranking.
 *
 * No I/O here — everything is deterministic and unit-testable.
 */

/**
 * Escape a literal glob into a RegExp source, mapping `*` to `.*`.
 * @param {string} pattern
 * @returns {string} anchored RegExp source.
 */
export function globToRegExpSource(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${escaped.replace(/\\\*/g, '.*')}$`;
}

/**
 * Classify a branch name against the plugin's resolved config.
 * @param {string} branch
 * @param {{ mainBranches: readonly string[], releasePattern: string }} resolved
 * @returns {boolean} true when the branch is a protected main branch.
 */
export function isMainBranch(branch, resolved) {
  return resolved.mainBranches.includes(branch);
}

/**
 * Classify a branch name as a release branch per the configured glob.
 * `*` matches any run of characters (including `/`), erring protective.
 * @param {string} branch
 * @param {{ mainBranches: readonly string[], releasePattern: string }} resolved
 * @returns {boolean}
 */
export function isReleaseBranch(branch, resolved) {
  return new RegExp(globToRegExpSource(resolved.releasePattern)).test(branch);
}

/**
 * Parse the raw input of /create-branch-from: the first token is the source
 * branch, an optional second token is the new branch name; anything beyond
 * that is a usage error.
 *
 * @param {string} rawInput
 * @returns {{ ok: true, source: string, newName: string | null } | { ok: false, error: string }}
 */
export function parseCreateBranchInput(rawInput) {
  const tokens = rawInput.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return {
      ok: false,
      error: 'usage: /create-branch-from <source-branch> [new-branch] — the source branch is required',
    };
  }
  if (tokens.length > 2) {
    return {
      ok: false,
      error: `usage: /create-branch-from <source-branch> [new-branch] — got ${tokens.length} arguments (${tokens.join(' ')}); branch names cannot contain whitespace`,
    };
  }
  const [source, newName = null] = tokens;
  if (source.startsWith('-')) {
    return { ok: false, error: `invalid source branch '${source}': branch names cannot start with '-'` };
  }
  if (newName !== null && newName.startsWith('-')) {
    return { ok: false, error: `invalid new branch name '${newName}': branch names cannot start with '-'` };
  }
  return { ok: true, source, newName };
}

/**
 * Levenshtein edit distance (classic DP, O(len·len), fine for branch names).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
}

/** Drop a leading `origin/` for similarity scoring only. */
const remotePrefix = /^origin\//;

/**
 * Score one branch as a candidate for a missed query. Lower is better.
 *
 * A branch qualifies when its edit distance to the query is small relative
 * to the name length, or when either name contains the other (a strong
 * signal for long names where edit distance is meaningless).
 *
 * @param {{ name: string, remote: boolean }} branch
 * @param {string} query the branch name the user typed.
 * @returns {number | null} score, or null when the branch is not a candidate.
 */
export function scoreCandidate(branch, query) {
  const shortName = branch.name.replace(remotePrefix, '');
  const left = shortName.toLowerCase();
  const right = query.toLowerCase();
  if (left === right) return -100; // case-only or remote-prefix variant of the query
  const distance = levenshtein(left, right);
  const threshold = Math.max(3, Math.floor(Math.max(left.length, right.length) * 0.4));
  const substring = left.includes(right) || right.includes(left);
  if (distance > threshold && !substring) return null;
  let score = distance;
  if (substring) score -= 3;
  if (left.startsWith(right) || right.startsWith(left)) score -= 1;
  if (branch.remote) score += 0.5; // prefer local branches on ties
  return score;
}

/**
 * Rank branches similar to a missed query.
 * @param {readonly { name: string, remote: boolean }[]} branches
 * @param {string} query
 * @param {number} limit
 * @returns {{ name: string, remote: boolean }[]} best candidates, best first.
 */
export function rankCandidates(branches, query, limit = 6) {
  const seen = new Set();
  const scored = [];
  for (const branch of branches) {
    if (seen.has(branch.name)) continue;
    seen.add(branch.name);
    const score = scoreCandidate(branch, query);
    if (score !== null) scored.push({ branch, score });
  }
  scored.sort((a, b) => (a.score - b.score) || a.branch.name.localeCompare(b.branch.name));
  return scored.slice(0, limit).map((entry) => entry.branch);
}

/**
 * Classify `git status --porcelain` lines into staged / unstaged / untracked.
 * @param {string} porcelain raw `git status --porcelain` output ('' when clean).
 * @returns {{ staged: string[], unstaged: string[], untracked: string[] }}
 */
export function classifyStatus(porcelain) {
  const result = { staged: [], unstaged: [], untracked: [] };
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    const path = line.slice(3);
    if (x === '?' && y === '?') {
      result.untracked.push(path);
    } else {
      if (x !== ' ' && x !== '?') result.staged.push(path);
      if (y !== ' ' && y !== '?') result.unstaged.push(path);
    }
  }
  return result;
}

/**
 * Parse `git for-each-ref --format=%(refname) refs/heads refs/remotes/origin`
 * output into a branch list. `refs/remotes/origin/HEAD` is skipped.
 * @param {string} refnames
 * @returns {{ name: string, remote: boolean }[]}
 */
export function parseBranchRefs(refnames) {
  const branches = [];
  const seen = new Set();
  for (const rawLine of refnames.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line.startsWith('refs/heads/')) {
      const name = line.slice('refs/heads/'.length);
      if (name === '' || seen.has(name)) continue;
      seen.add(name);
      branches.push({ name, remote: false });
    } else if (line.startsWith('refs/remotes/origin/')) {
      const short = line.slice('refs/remotes/origin/'.length);
      if (short === '' || short === 'HEAD') continue;
      const name = `origin/${short}`;
      if (seen.has(name)) continue;
      seen.add(name);
      branches.push({ name, remote: true });
    }
  }
  return branches;
}

/**
 * Describe one porcelain classification for the steered prompt.
 * @param {{ staged: string[], unstaged: string[], untracked: string[] }} status
 * @returns {string}
 */
export function summarizeStatus(status) {
  const parts = [
    `staged: ${status.staged.length} path(s)`,
    `unstaged: ${status.unstaged.length} path(s)`,
    `untracked: ${status.untracked.length} path(s)`,
  ];
  return parts.join(', ');
}
