#!/usr/bin/env node
// Makes CONSTITUTION.md Article VII's reviewer read-only contract mechanical,
// instead of purely instructional, for ONE surface: the Write/Edit/
// MultiEdit/NotebookEdit tool path. Wired via .claude/settings.json
// (PreToolUse, matcher Write|Edit|MultiEdit|NotebookEdit).
//
// THIS HOOK DOES NOT RESTRICT BASH AT ALL. A round-1 attempt to also police
// Bash command text (an allowlist of first tokens plus a denylist of
// mutating substrings) was deleted after a Grader FAIL: the allowlist both
// over-permitted (`npx eslint . --fix`, `npm run agents:check -- --write`,
// `npm run index:work`, and a `node -e` async-`fs` write that could
// overwrite this very settings.json) and wrongly denied the Grader the
// gate-report reducer CLI that Article VII expressly permits it, while also
// denying harmless shell (`[ -f x ]`, `cd … && npx vitest run x`,
// `basename`, `| xargs grep`, `grep "a && rm" f`). A policy that produces
// both false negatives and false positives, and that a live probe showed
// never fired for a subagent at all, is worse than no Bash enforcement — it
// would be reported as a safeguard that is not one. So a constrained
// reviewer can still write files by shelling out through Bash; the
// read-only contract over commands remains instructional, resting on the
// agent, exactly as it did before this hook existed. A future Bash policy
// must be a safe-invocation ALLOWLIST — deny by default, admitting only
// fully-matched complete command strings or AST-parsed shell — never a
// denylist of dangerous fragments.
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
//       UNVERIFIED end-to-end: a round-1 live probe showed a subagent spawned
//       in that session was not refused by this hook at all. Whether the
//       mechanism constrains anything in a real session needs a fresh
//       session to confirm; it is not re-tested here.
//
// KNOWN GAPS in what IS enforced:
//   - An `agent_type` of `redhat` (hyphen dropped) or one spelled with a
//     Unicode confusable (e.g. a U+2011 non-breaking hyphen in place of an
//     ASCII hyphen) is not in KNOWN_AGENT_TYPES / does not normalize to a
//     known key, so this hook is a silent no-op for that call — the
//     normalizer only strips whitespace and underscores, it does not
//     canonicalize confusable characters. Nothing in the repo cross-checks
//     this hardcoded agent set against `.claude/agents/*.md` frontmatter, so
//     a future rename of any reviewer profile turns this into a permanent,
//     silent no-op for that profile.
//   - A write reaching the tree through an MCP tool (rather than
//     Write/Edit/MultiEdit/NotebookEdit) is not matched by this hook at all.
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
      // Mirror decide()'s own fail-closed branch: an unexpected throw here
      // must not silently allow a named reviewer through just because the
      // failure happened one level up instead of inside decide() itself.
      const agentType = normalizeAgentType(
        input && typeof input === 'object' ? input.agent_type : undefined
      );
      result = KNOWN_AGENT_TYPES.has(agentType)
        ? {
            allow: false,
            reason: `${agentType}: internal error while classifying this tool call, denied fail-closed. ${REASON_SUFFIX}`,
          }
        : { allow: true };
    }

    if (result && result.allow === false) {
      process.stderr.write(`${result.reason || 'Denied by reviewer-read-only hook.'}\n`);
      process.exit(2);
    }
    process.exit(0);
  });
}
