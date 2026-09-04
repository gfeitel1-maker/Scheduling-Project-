#!/usr/bin/env node
// Portable agent team, Phase 1: generate .claude/agents/*.md from the reusable
// organization fragment source (~/.claude/organization/fragments/) plus this
// project's per-role bindings (docs/governance/agent-bindings/).
//
// --check (default): generate in memory, diff against the committed profiles,
//   exit 1 on any divergence. This is the acceptance test from
//   docs/adr/2026-09-04-portable-agent-team-compatibility-layer.md: Phase 1
//   changes only how the twelve profiles are produced, never their content.
// --write: write the generated content over .claude/agents/*.md.
//
// See docs/adr/2026-09-04-portable-agent-team-compatibility-layer.md.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, '.claude', 'agents');
const BINDINGS_DIR = path.join(ROOT, 'docs', 'governance', 'agent-bindings');
const ORG_DIR = path.join(os.homedir(), '.claude', 'organization');
const FRAGMENTS_DIR = path.join(ORG_DIR, 'fragments');
const MANIFEST_PATH = path.join(BINDINGS_DIR, 'manifest.json');

const PLACEHOLDER_RE = /\{\{([A-Z_]+)\}\}/g;

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function loadFragment(name) {
  const fragPath = path.join(FRAGMENTS_DIR, `${name}.md`);
  if (!fs.existsSync(fragPath)) {
    throw new Error(`Missing organization fragment: ${fragPath}`);
  }
  // Fragment files end with a trailing newline; strip it so splicing back into
  // the binding via a bare placeholder line reproduces the original exactly.
  return fs.readFileSync(fragPath, 'utf8').replace(/\n$/, '');
}

function generate(bindingContent) {
  return bindingContent.replace(PLACEHOLDER_RE, (_, fragName) => loadFragment(fragName));
}

function main() {
  const mode = process.argv.includes('--write') ? 'write' : 'check';

  if (!fs.existsSync(ORG_DIR)) {
    console.error(`No organization package at ${ORG_DIR} — nothing to generate from.`);
    process.exit(1);
  }
  const orgVersion = fs.existsSync(path.join(ORG_DIR, 'VERSION'))
    ? fs.readFileSync(path.join(ORG_DIR, 'VERSION'), 'utf8').trim()
    : 'unversioned';

  const bindingFiles = fs.readdirSync(BINDINGS_DIR).filter((f) => f.endsWith('.md')).sort();
  const manifest = { org_version: orgVersion, roles: {} };
  let mismatches = 0;

  for (const f of bindingFiles) {
    const role = f.replace(/\.md$/, '');
    const bindingPath = path.join(BINDINGS_DIR, f);
    const bindingContent = fs.readFileSync(bindingPath, 'utf8');
    const generated = generate(bindingContent);
    const agentPath = path.join(AGENTS_DIR, f);

    manifest.roles[role] = {
      adapter_hash: sha256(bindingContent),
      generated_hash: sha256(generated),
    };

    if (mode === 'write') {
      fs.writeFileSync(agentPath, generated);
      console.log(`wrote  ${f}`);
      continue;
    }

    if (!fs.existsSync(agentPath)) {
      console.error(`MISSING  ${f} — no committed profile to compare against`);
      mismatches++;
      continue;
    }
    const current = fs.readFileSync(agentPath, 'utf8');
    if (current === generated) {
      console.log(`match  ${f}`);
    } else {
      console.error(`DIFFERS  ${f} — generated output does not match the committed profile`);
      mismatches++;
    }
  }

  if (mode === 'write') {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`\nwrote ${MANIFEST_PATH}`);
    return;
  }

  if (mismatches > 0) {
    console.error(`\n${mismatches} profile(s) diverged from the generator. Not behavior-preserving — fix before merging.`);
    process.exit(1);
  }
  console.log('\nAll generated profiles are byte-identical to the committed .claude/agents/*.md files.');
}

main();
