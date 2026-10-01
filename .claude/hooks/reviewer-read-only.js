#!/usr/bin/env node
// Makes CONSTITUTION.md Article VII's reviewer read-only contract mechanical
// instead of instructional. A subagent's `tools:` frontmatter only accepts
// bare tool names — `Bash` can't be narrowed to "read-only commands" there —
// so this PreToolUse hook is the only surface that sees the actual command
// text and can refuse it. Wired via .claude/settings.json (PreToolUse,
// matchers Write|Edit|MultiEdit|NotebookEdit and Bash).
//
// THREE DOCUMENTED PLATFORM GAPS (code.claude.com/docs/en/hooks.md, as read
// 2026-10-01) this script has to guess past:
//   (a) the exact VALUE of `agent_type` for a subagent tool call is not
//       documented (frontmatter `name:` vs. a display-cased form). Resolved
//       by normalizing (trim, lowercase, collapse spaces/underscores to a
//       single hyphen) and matching the normalized value against the policy
//       keys below, which are already the frontmatter names.
//   (b) the `tool_input` field name carrying a Write/Edit target path is not
//       documented. Resolved by checking `file_path`, then `path`, then
//       `notebook_path`, and denying (fail closed) when none is present.
//   (c) whether hooks are re-read mid-session is not documented — a
//       `.claude/settings.json` created during a run might not govern
//       subagents already spawned in that same session. Not addressed here;
//       it governs every session started after this file is committed.
//
// RESIDUAL BYPASSES — this is a heuristic guard over command text, not a
// sandbox, and it cannot close these:
//   - A `node -e`/`-p` script that reaches a write through dynamic, indirect
//     access (e.g. `(await import("fs")).writeFileSync` built from string
//     concatenation) rather than one of the literal banned substrings below.
//     Any interpreter NOT on the Bash allowlist is denied outright, so this
//     is narrowly about the one interpreter the allowlist does admit.
//   - Unicode lookalike characters standing in for ASCII in a command
//     (e.g. a homoglyph for `>`) — substring matching does not normalize
//     confusables.
//   - A write performed through an MCP tool rather than Write/Edit/
//     MultiEdit/NotebookEdit/Bash — this hook only matches the named tools
//     from PreToolUse's `tool_name`.
//   - In general: matching on command TEXT is a heuristic, not a shell
//     parser. It raises the cost of a violation and makes the common case
//     impossible; it is not a guarantee.
//
// Fail-open / fail-closed asymmetry (deliberate): malformed or unreadable
// stdin, or an unrecognized `agent_type`, always ALLOWS — this hook must
// never break an unrelated session. But once `agent_type` resolves to one of
// the named reviewer profiles below, an internal error during classification
// DENIES instead — a thrown error must never silently let a reviewer through.

const REVIEWER_WRITE_DENY = new Set(['code-reviewer', 'red-hat', 'security', 'grader']);

const SCOPED_WRITE_DIRS = {
  'architecture-auditor': 'docs/work/architecture-reports/',
  'security-assessment': 'docs/work/security/',
};

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const KNOWN_AGENT_TYPES = new Set([
  ...REVIEWER_WRITE_DENY,
  ...Object.keys(SCOPED_WRITE_DIRS),
]);

const REASON_SUFFIX =
  'Reviewers are read-only (CONSTITUTION Art. VII); ask the Verifier to run this on a scratch copy.';

function normalizeAgentType(raw) {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return normalized.length > 0 ? normalized : null;
}

function resolveTargetPath(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  if (typeof toolInput.file_path === 'string') return toolInput.file_path;
  if (typeof toolInput.path === 'string') return toolInput.path;
  if (typeof toolInput.notebook_path === 'string') return toolInput.notebook_path;
  if (Array.isArray(toolInput.edits) && typeof toolInput.file_path === 'string') {
    return toolInput.file_path;
  }
  return null;
}

// Collapse `a/b/../c` segments without touching the filesystem — we are
// classifying a string the tool call wants to use, not resolving a real path.
function normalizeRelativePath(p) {
  const parts = p.split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

function isUnderAllowedDir(targetPath, allowedDir) {
  if (typeof targetPath !== 'string' || targetPath.length === 0) return false;
  if (targetPath.startsWith('/')) return false; // absolute path outside the repo-relative scope
  const normalized = normalizeRelativePath(targetPath);
  return normalized.startsWith(allowedDir) && normalized !== allowedDir.replace(/\/$/, '');
}

// ---- Shared Bash policy -----------------------------------------------

const UNCONDITIONAL_DENY_SUBSTRINGS = [
  'rm ',
  'mv ',
  'cp ',
  'touch ',
  'mkdir ',
  'chmod ',
  'sed -i',
  'perl -i',
  'truncate',
  'dd ',
  'tee ',
  'install ',
  'ln ',
  '>|',
  'npm install',
  'npm ci',
  'npm rebuild',
  'npx electron-rebuild',
];

const DENIED_GIT_SUBCOMMANDS = new Set([
  'stash',
  'checkout',
  'switch',
  'reset',
  'commit',
  'apply',
  'am',
  'rebase',
  'merge',
  'cherry-pick',
  'push',
  'clean',
  'restore',
  'add',
  'rm',
  'mv',
]);

const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'diff',
  'log',
  'show',
  'status',
  'blame',
  'rev-parse',
  'ls-files',
  'grep',
]);

const SIMPLE_ALLOWED_COMMANDS = new Set([
  'grep',
  'rg',
  'ugrep',
  'cat',
  'head',
  'tail',
  'sed',
  'awk',
  'ls',
  'find',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'diff',
  'stat',
  'file',
  'jq',
  'echo',
  'pwd',
  'true',
]);

const NPM_RUN_ALLOWED_SCRIPTS = new Set([
  'check:governance',
  'agents:check',
  'licenses:check',
  'lint',
  'index:work',
  'security',
  'test:integration',
]);

const GRAPHIFY_ALLOWED_SUBCOMMANDS = new Set(['query', 'affected', 'explain', 'god-nodes', 'path']);

const FIND_WRITE_FLAGS = ['-delete', '-exec', '-execdir', '-ok', '-fprint'];

const UNPARSEABLE_PATTERNS = [/\$\(/, /`/, /\beval\b/, /<</];

function splitSegments(command) {
  // Split on ;, &&, ||, and newlines. Keep it simple: these are the
  // documented compound operators we must evaluate independently.
  return command
    .split(/\n|;|&&|\|\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function splitPipeline(segment) {
  return segment.split('|').map((s) => s.trim()).filter((s) => s.length > 0);
}

function hasUnconditionalDenySubstring(text) {
  for (const needle of UNCONDITIONAL_DENY_SUBSTRINGS) {
    if (text.includes(needle)) return true;
  }
  return false;
}

function hasDeniedRedirection(text) {
  // Allow 2>&1, 2>/dev/null, >/dev/null (and the spaced forms). Deny every
  // other > or >>.
  const withoutAllowed = text
    .replace(/2>&1/g, '')
    .replace(/2>\s*\/dev\/null/g, '')
    .replace(/>\s*\/dev\/null/g, '');
  return />{1,2}/.test(withoutAllowed);
}

function hasDeniedPipeTarget(pipelineStages) {
  // A pipe INTO tee/xargs/sh/bash/zsh is denied. Only the stages after the
  // first matter — the first stage is the pipeline's source, not a target.
  for (let i = 1; i < pipelineStages.length; i++) {
    const firstToken = firstTokenOf(pipelineStages[i]);
    if (['tee', 'xargs', 'sh', 'bash', 'zsh'].includes(firstToken)) return true;
  }
  return false;
}

function stripLeadingCdAndEnv(stage) {
  let s = stage.trim();
  // Strip a leading `cd <path> &&` — already removed by segment splitting on
  // `&&`, but a stage can still begin with `cd <path>;` style chains inside a
  // pipeline stage in principle; handle a leading `cd <path>` defensively by
  // just leaving it, since `cd` alone is not on the allowlist and that is
  // correct (a bare `cd` segment should not itself be treated as a command
  // needing classification beyond "not on the allowlist, but harmless" —
  // Shoresh's reviewers run with cwd already set, so we don't special-case cd
  // as a no-op allow; it simply isn't produced by the allowlist and any
  // segment consisting only of `cd ...` is denied by the default fail-closed
  // path below, which is acceptable: Bash tool calls in this project always
  // carry the full command, not bare navigation).
  // Strip NAME=value env assignments.
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(s)) {
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
  }
  return s;
}

function firstTokenOf(stage) {
  const stripped = stripLeadingCdAndEnv(stage);
  const match = stripped.match(/^(\S+)/);
  return match ? match[1] : '';
}

function tokenize(stage) {
  return stripLeadingCdAndEnv(stage).trim().split(/\s+/).filter(Boolean);
}

// Returns true when `stage` (a single pipeline stage) is allowed under the
// read/test allowlist, assuming it already cleared the unconditional-deny and
// redirection checks.
function isAllowedStage(stage) {
  const tokens = tokenize(stage);
  if (tokens.length === 0) return false;
  const [cmd, ...rest] = tokens;

  // Explicitly deny shell-escape / indirection tricks even though they are
  // not literally on the allowlist (defense documented, not just implied).
  if (['\\git', 'command', 'builtin', 'env', 'python', 'python3', 'perl', 'ruby', 'php', 'osascript', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'open'].includes(cmd)) {
    return false;
  }

  if (cmd === 'git') {
    if (rest.some((t) => t === '-C' || t.startsWith('--git-dir') || t.startsWith('--work-tree'))) {
      return false;
    }
    const subcommand = rest.find((t) => !t.startsWith('-'));
    if (subcommand === 'worktree' && rest.includes('list')) return true;
    if (subcommand === 'branch' && rest.includes('--show-current')) return true;
    if (!subcommand) return false;
    if (DENIED_GIT_SUBCOMMANDS.has(subcommand)) return false;
    return ALLOWED_GIT_SUBCOMMANDS.has(subcommand);
  }

  if (SIMPLE_ALLOWED_COMMANDS.has(cmd)) {
    if (cmd === 'sed' && rest.includes('-i')) return false;
    if (cmd === 'awk' && rest.includes('-i')) return false;
    if (cmd === 'find' && rest.some((t) => FIND_WRITE_FLAGS.includes(t))) return false;
    return true;
  }

  if (cmd === 'node') {
    const flagIdx = rest.findIndex((t) => t === '-e' || t === '-p');
    if (flagIdx === -1) return false;
    const script = rest.slice(flagIdx + 1).join(' ');
    const bannedCalls = ['writeFileSync', 'appendFileSync', 'rmSync', 'renameSync', 'mkdirSync', 'execSync', 'spawn'];
    return !bannedCalls.some((fn) => script.includes(fn));
  }

  if (cmd === 'npm') {
    if (rest[0] === 'run' && NPM_RUN_ALLOWED_SCRIPTS.has(rest[1])) return true;
    if (rest[0] === 'test' && rest[1] === '--') return true;
    return false;
  }

  if (cmd === 'npx') {
    if (rest[0] === 'vitest' && rest[1] === 'run') return true;
    if (rest[0] === 'eslint') return true;
    return false;
  }

  if (cmd === 'graphify') {
    return GRAPHIFY_ALLOWED_SUBCOMMANDS.has(rest[0]);
  }

  return false;
}

function bashPolicyDecision(command, agentLabel) {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { allow: true };
  }

  for (const pattern of UNPARSEABLE_PATTERNS) {
    if (pattern.test(command)) {
      return {
        allow: false,
        reason: `${agentLabel}: Bash command "${command}" cannot be classified (contains command substitution, a backtick, eval, or a heredoc) — fail-closed per the allowlist policy. ${REASON_SUFFIX}`,
      };
    }
  }

  const segments = splitSegments(command);
  if (segments.length === 0) {
    return { allow: true };
  }

  for (const segment of segments) {
    if (hasUnconditionalDenySubstring(segment)) {
      return {
        allow: false,
        reason: `${agentLabel}: Bash segment "${segment}" matches an unconditionally denied mutating pattern. ${REASON_SUFFIX}`,
      };
    }
    if (hasDeniedRedirection(segment)) {
      return {
        allow: false,
        reason: `${agentLabel}: Bash segment "${segment}" redirects output into a path outside the allowed /dev/null and 2>&1 forms. ${REASON_SUFFIX}`,
      };
    }

    const stages = splitPipeline(segment);
    if (hasDeniedPipeTarget(stages)) {
      return {
        allow: false,
        reason: `${agentLabel}: Bash segment "${segment}" pipes into a disallowed target (tee/xargs/sh/bash/zsh). ${REASON_SUFFIX}`,
      };
    }

    for (const stage of stages) {
      if (!isAllowedStage(stage)) {
        return {
          allow: false,
          reason: `${agentLabel}: Bash segment "${stage}" is not on the read/test allowlist. ${REASON_SUFFIX}`,
        };
      }
    }
  }

  return { allow: true };
}

// ---- Top-level policy ---------------------------------------------------

function decideForWriteTool(agentType, toolName, toolInput) {
  if (REVIEWER_WRITE_DENY.has(agentType)) {
    return {
      allow: false,
      reason: `${agentType}: ${toolName} is denied unconditionally for this profile (write tools are never permitted). ${REASON_SUFFIX}`,
    };
  }

  const allowedDir = SCOPED_WRITE_DIRS[agentType];
  if (allowedDir) {
    const targetPath = resolveTargetPath(toolInput);
    if (!targetPath) {
      return {
        allow: false,
        reason: `${agentType}: ${toolName} has no determinable target path, denied fail-closed. ${REASON_SUFFIX}`,
      };
    }
    if (!isUnderAllowedDir(targetPath, allowedDir)) {
      return {
        allow: false,
        reason: `${agentType}: ${toolName} target "${targetPath}" is outside the permitted ${allowedDir} directory for this profile. ${REASON_SUFFIX}`,
      };
    }
    return { allow: true };
  }

  return { allow: true };
}

export function decide(input) {
  const rawAgentType = input && typeof input === 'object' ? input.agent_type : undefined;
  const agentType = normalizeAgentType(rawAgentType);

  if (agentType === null || !KNOWN_AGENT_TYPES.has(agentType)) {
    return { allow: true };
  }

  try {
    const toolName = input.tool_name;
    const toolInput = input.tool_input;

    if (WRITE_TOOLS.has(toolName)) {
      return decideForWriteTool(agentType, toolName, toolInput);
    }

    if (toolName === 'Bash') {
      const command = toolInput && typeof toolInput === 'object' ? toolInput.command : undefined;
      return bashPolicyDecision(command, agentType);
    }

    return { allow: true };
  } catch {
    // A named reviewer profile resolved, but classification threw. Fail
    // closed here — the one deliberate exception to "malformed input always
    // allows", because this branch means we already know who the caller is.
    return {
      allow: false,
      reason: `${agentType}: internal error while classifying this tool call, denied fail-closed. ${REASON_SUFFIX}`,
    };
  }
}

// ---- CLI entry ------------------------------------------------------------

function isMainModule() {
  // Guard the CLI side effects so `decide` stays importable/testable without
  // spawning a process.
  return process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
}

if (isMainModule()) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    raw += chunk;
  });
  process.stdin.on('end', () => {
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      process.exit(0); // malformed stdin must never break an unrelated session
    }

    let result;
    try {
      result = decide(input);
    } catch {
      result = { allow: true };
    }

    if (result && result.allow === false) {
      process.stderr.write(`${result.reason || 'Denied by reviewer-read-only hook.'}\n`);
      process.exit(2);
    }
    process.exit(0);
  });
}
