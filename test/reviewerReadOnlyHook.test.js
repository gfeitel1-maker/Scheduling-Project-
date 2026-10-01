import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decide } from '../.claude/hooks/reviewer-read-only.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOOK_PATH = resolve(ROOT, '.claude/hooks/reviewer-read-only.js')

const REVIEWERS = ['code-reviewer', 'red-hat', 'security', 'grader']
const NON_REVIEWERS = ['maker', 'verifier', 'governor', 'tester', 'designer', 'architect']

describe('decide — agent_type normalization', () => {
  it('normalizes whitespace, case, and underscores before matching a reviewer profile', () => {
    expect(decide({ agent_type: 'Code_Reviewer', tool_name: 'Write', tool_input: { file_path: 'src/App.jsx' } }).allow).toBe(false)
    expect(decide({ agent_type: '  red hat  ', tool_name: 'Write', tool_input: { file_path: 'src/App.jsx' } }).allow).toBe(false)
  })
})

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

  it('denies a write with a traversal escaping the allowed directory', () => {
    const result = decide({
      agent_type: 'architecture-auditor',
      tool_name: 'Write',
      tool_input: { file_path: 'docs/work/architecture-reports/../../src/App.jsx' },
    })
    expect(result.allow).toBe(false)
  })

  it('denies an absolute path', () => {
    const result = decide({
      agent_type: 'architecture-auditor',
      tool_name: 'Write',
      tool_input: { file_path: '/etc/passwd' },
    })
    expect(result.allow).toBe(false)
  })

  it('denies a write with no determinable target path', () => {
    const result = decide({ agent_type: 'architecture-auditor', tool_name: 'Write', tool_input: {} })
    expect(result.allow).toBe(false)
  })

  it('denies a bare write of the allowed directory itself', () => {
    const result = decide({
      agent_type: 'architecture-auditor',
      tool_name: 'Write',
      tool_input: { file_path: 'docs/work/architecture-reports' },
    })
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

  it('denies a write with a traversal escaping the allowed directory', () => {
    const result = decide({
      agent_type: 'security-assessment',
      tool_name: 'Write',
      tool_input: { file_path: 'docs/work/security/../../src/App.jsx' },
    })
    expect(result.allow).toBe(false)
  })

  it('denies an absolute path', () => {
    const result = decide({
      agent_type: 'security-assessment',
      tool_name: 'Write',
      tool_input: { file_path: '/etc/passwd' },
    })
    expect(result.allow).toBe(false)
  })
})

describe('decide — no-op for everyone else', () => {
  for (const agent_type of NON_REVIEWERS) {
    it(`allows ${agent_type} on Write, Edit, and Bash`, () => {
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

  it('allows when agent_type is null', () => {
    expect(decide({ agent_type: null, tool_name: 'Write', tool_input: { file_path: 'src/App.jsx' } }).allow).toBe(true)
  })

  it('allows when agent_type is non-string', () => {
    expect(decide({ agent_type: 42, tool_name: 'Write', tool_input: { file_path: 'src/App.jsx' } }).allow).toBe(true)
  })

  it('a reviewer profile is unrestricted on Bash — the hook does not police Bash at all', () => {
    for (const agent_type of REVIEWERS) {
      expect(decide({ agent_type, tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }).allow).toBe(true)
      expect(decide({ agent_type, tool_name: 'Bash', tool_input: { command: 'git stash' } }).allow).toBe(true)
    }
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

  it('exits 0 for malformed (non-JSON) stdin instead of crashing', () => {
    const result = spawnSync('node', [HOOK_PATH], { input: 'not json at all {{{', cwd: ROOT, encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })
})
