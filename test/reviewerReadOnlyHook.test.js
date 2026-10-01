import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decide } from '../.claude/hooks/reviewer-read-only.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOOK_PATH = resolve(ROOT, '.claude/hooks/reviewer-read-only.js')

const REVIEWERS = ['code-reviewer', 'red-hat', 'security', 'grader']
const NON_REVIEWERS = ['maker', 'verifier', 'governor', 'tester', 'designer', 'architect']

describe('decide — write tools', () => {
  for (const agent_type of REVIEWERS) {
    it(`denies ${agent_type} on Write`, () => {
      const result = decide({ agent_type, tool_name: 'Write', tool_input: { file_path: 'src/App.jsx' } })
      expect(result.allow).toBe(false)
    })
    it(`denies ${agent_type} on Edit`, () => {
      const result = decide({ agent_type, tool_name: 'Edit', tool_input: { file_path: 'src/App.jsx' } })
      expect(result.allow).toBe(false)
    })
  }
})

describe('decide — Bash allowlist for reviewers', () => {
  it('allows grader to run vitest', () => {
    const result = decide({ agent_type: 'grader', tool_name: 'Bash', tool_input: { command: 'npx vitest run x' } })
    expect(result.allow).toBe(true)
  })

  it('allows code-reviewer git diff against a range', () => {
    const result = decide({ agent_type: 'code-reviewer', tool_name: 'Bash', tool_input: { command: 'git diff origin/main...HEAD' } })
    expect(result.allow).toBe(true)
  })

  it('denies code-reviewer git stash', () => {
    const result = decide({ agent_type: 'code-reviewer', tool_name: 'Bash', tool_input: { command: 'git stash' } })
    expect(result.allow).toBe(false)
  })

  it('denies code-reviewer git checkout -- file', () => {
    const result = decide({ agent_type: 'code-reviewer', tool_name: 'Bash', tool_input: { command: 'git checkout -- file' } })
    expect(result.allow).toBe(false)
  })

  it('denies code-reviewer redirecting output into a file', () => {
    const result = decide({ agent_type: 'code-reviewer', tool_name: 'Bash', tool_input: { command: 'echo x > file' } })
    expect(result.allow).toBe(false)
  })

  it('allows code-reviewer redirecting stderr to /dev/null', () => {
    const result = decide({ agent_type: 'code-reviewer', tool_name: 'Bash', tool_input: { command: 'echo x 2>/dev/null' } })
    expect(result.allow).toBe(true)
  })

  it('denies code-reviewer a compound command with a mutating tail', () => {
    const result = decide({ agent_type: 'code-reviewer', tool_name: 'Bash', tool_input: { command: 'npx vitest run x && rm -rf foo' } })
    expect(result.allow).toBe(false)
  })

  it('denies code-reviewer piping into tee', () => {
    const result = decide({ agent_type: 'code-reviewer', tool_name: 'Bash', tool_input: { command: 'cat a | tee b' } })
    expect(result.allow).toBe(false)
  })

  it('allows code-reviewer piping into grep', () => {
    const result = decide({ agent_type: 'code-reviewer', tool_name: 'Bash', tool_input: { command: 'cat a | grep b' } })
    expect(result.allow).toBe(true)
  })

  it('denies code-reviewer an unparseable command containing command substitution, fail-closed', () => {
    const result = decide({ agent_type: 'code-reviewer', tool_name: 'Bash', tool_input: { command: 'echo $(whoami)' } })
    expect(result.allow).toBe(false)
    expect(result.reason).toMatch(/allowlist|Verifier/i)
  })

  it('denies code-reviewer a leading backslash-escaped git stash', () => {
    const result = decide({ agent_type: 'code-reviewer', tool_name: 'Bash', tool_input: { command: '\\git stash' } })
    expect(result.allow).toBe(false)
  })

  it('denies code-reviewer "command git stash"', () => {
    const result = decide({ agent_type: 'code-reviewer', tool_name: 'Bash', tool_input: { command: 'command git stash' } })
    expect(result.allow).toBe(false)
  })

  it('denies code-reviewer a python one-liner that writes a file', () => {
    const result = decide({ agent_type: 'code-reviewer', tool_name: 'Bash', tool_input: { command: 'python3 -c \'open("f","w")\'' } })
    expect(result.allow).toBe(false)
  })

  it('denies code-reviewer git -C targeting another repo', () => {
    const result = decide({ agent_type: 'code-reviewer', tool_name: 'Bash', tool_input: { command: 'git -C /elsewhere stash' } })
    expect(result.allow).toBe(false)
  })

  it('denies a find segment with -delete', () => {
    const result = decide({ agent_type: 'code-reviewer', tool_name: 'Bash', tool_input: { command: 'find . -name "*.tmp" -delete' } })
    expect(result.allow).toBe(false)
  })
})

describe('decide — architecture-auditor path scoping', () => {
  it('allows a write under docs/work/architecture-reports/', () => {
    const result = decide({
      agent_type: 'architecture-auditor',
      tool_name: 'Write',
      tool_input: { file_path: 'docs/work/architecture-reports/2026-10-01-x.md' },
    })
    expect(result.allow).toBe(true)
  })

  it('denies a write to src/App.jsx', () => {
    const result = decide({
      agent_type: 'architecture-auditor',
      tool_name: 'Write',
      tool_input: { file_path: 'src/App.jsx' },
    })
    expect(result.allow).toBe(false)
  })

  it('denies a mutating Bash command', () => {
    const result = decide({ agent_type: 'architecture-auditor', tool_name: 'Bash', tool_input: { command: 'git commit -m x' } })
    expect(result.allow).toBe(false)
  })
})

describe('decide — security-assessment path scoping', () => {
  it('allows a write under docs/work/security/', () => {
    const result = decide({
      agent_type: 'security-assessment',
      tool_name: 'Write',
      tool_input: { file_path: 'docs/work/security/2026-10-01-x.md' },
    })
    expect(result.allow).toBe(true)
  })

  it('denies a write to src/App.jsx', () => {
    const result = decide({
      agent_type: 'security-assessment',
      tool_name: 'Write',
      tool_input: { file_path: 'src/App.jsx' },
    })
    expect(result.allow).toBe(false)
  })

  it('denies a mutating Bash command', () => {
    const result = decide({ agent_type: 'security-assessment', tool_name: 'Bash', tool_input: { command: 'git commit -m x' } })
    expect(result.allow).toBe(false)
  })
})

describe('decide — no-op for everyone else', () => {
  for (const agent_type of NON_REVIEWERS) {
    it(`allows ${agent_type} on Write, Edit, and rm -rf`, () => {
      expect(decide({ agent_type, tool_name: 'Write', tool_input: { file_path: 'src/App.jsx' } }).allow).toBe(true)
      expect(decide({ agent_type, tool_name: 'Edit', tool_input: { file_path: 'src/App.jsx' } }).allow).toBe(true)
      expect(decide({ agent_type, tool_name: 'Bash', tool_input: { command: 'rm -rf anything' } }).allow).toBe(true)
    })
  }

  it('allows when agent_type is absent entirely (main session)', () => {
    expect(decide({ tool_name: 'Write', tool_input: { file_path: 'src/App.jsx' } }).allow).toBe(true)
    expect(decide({ tool_name: 'Edit', tool_input: { file_path: 'src/App.jsx' } }).allow).toBe(true)
    expect(decide({ tool_name: 'Bash', tool_input: { command: 'rm -rf anything' } }).allow).toBe(true)
  })
})

describe('end-to-end: CLI entry over stdin/stdout/exit code', () => {
  it('exits 2 with a non-empty stderr reason for a denied call', () => {
    const input = JSON.stringify({ agent_type: 'code-reviewer', tool_name: 'Write', tool_input: { file_path: 'src/App.jsx' } })
    const result = spawnSync('node', [HOOK_PATH], { input, cwd: ROOT, encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stderr.trim().length).toBeGreaterThan(0)
  })

  it('exits 0 with empty stdout for an allowed call', () => {
    const input = JSON.stringify({ agent_type: 'maker', tool_name: 'Write', tool_input: { file_path: 'src/App.jsx' } })
    const result = spawnSync('node', [HOOK_PATH], { input, cwd: ROOT, encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })
})
