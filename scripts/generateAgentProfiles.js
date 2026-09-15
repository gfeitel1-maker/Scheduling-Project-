#!/usr/bin/env node
// Portable agent team, Phase 1: generate .claude/agents/*.md from the reusable
// organization fragment source plus this project's per-role bindings
// (docs/governance/agent-bindings/).
//
// T165: the fragment source used to be resolved unconditionally to
// ~/.claude/organization — an untracked, unversioned directory outside the
// repo. That made the gate's verdict depend on whatever happened to exist on
// the machine running it (fresh clone / CI / second machine: hard exit 1).
// Fragments are now vendored into the repo at docs/governance/agent-fragments/
// (same VERSION + fragments/*.md shape as the original home package, so an
// override behaves identically), and that vendored copy is the default. Set
// SHORESH_ORG_DIR to point at a different fragment source (e.g. a live
// ~/.claude/organization during fragment development) when needed.
//
// --check (default): generate in memory, diff against the committed profiles,
//   exit 1 on any divergence. This is the acceptance test from
//   docs/adr/2026-09-04-portable-agent-team-compatibility-layer.md: Phase 1
//   changes only how the profiles are produced, never their content. --check
//   also verifies docs/governance/agent-bindings/manifest.json against
//   freshly computed hashes, so a manifest that has drifted from the
//   bindings/fragments it claims to describe fails the gate instead of
//   rotting silently.
// --write: write the generated content over .claude/agents/*.md, and refresh
//   the manifest to match.
//
// See docs/adr/2026-09-04-portable-agent-team-compatibility-layer.md.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(ROOT, '.claude', 'agents');
const BINDINGS_DIR = path.join(ROOT, 'docs', 'governance', 'agent-bindings');
const ORG_DIR = process.env.SHORESH_ORG_DIR
  ? path.resolve(process.env.SHORESH_ORG_DIR)
  : path.join(ROOT, 'docs', 'governance', 'agent-fragments');
const FRAGMENTS_DIR = path.join(ORG_DIR, 'fragments');
const MANIFEST_PATH = path.join(BINDINGS_DIR, 'manifest.json');

const PLACEHOLDER_RE = /\{\{([A-Z_]+)\}\}/g;

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// Populated by loadFragment as bindings reference fragments, so it only ever
// contains the fragments actually spliced into a profile this run.
const fragmentHashes = {};

function loadFragment(name) {
  const fragPath = path.join(FRAGMENTS_DIR, `${name}.md`);
  if (!fs.existsSync(fragPath)) {
    throw new Error(`Missing organization fragment: ${fragPath}`);
  }
  const raw = fs.readFileSync(fragPath, 'utf8');
  fragmentHashes[name] = sha256(raw);
  // Fragment files end with a trailing newline; strip it so splicing back into
  // the binding via a bare placeholder line reproduces the original exactly.
  return raw.replace(/\n$/, '');
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
  // fragment_source is relative-to-ROOT when the vendored default is in play,
  // and an absolute/relative path as given when SHORESH_ORG_DIR overrides it —
  // either way it records which fragment tree produced this manifest.
  const manifest = { fragment_source: path.relative(ROOT, ORG_DIR), org_version: orgVersion, fragments: fragmentHashes, roles: {} };
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

  // The manifest is load-bearing, not just a --write byproduct: verify its
  // recorded hashes against what this run just computed so a hand-edited or
  // stale manifest.json fails the gate instead of rotting silently (T165).
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`MISSING  ${path.relative(ROOT, MANIFEST_PATH)} — no committed manifest to verify against`);
    mismatches++;
  } else {
    const committed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const committedHashes = JSON.stringify({ fragments: committed.fragments, roles: committed.roles });
    const freshHashes = JSON.stringify({ fragments: manifest.fragments, roles: manifest.roles });
    if (committedHashes === freshHashes) {
      console.log(`match  ${path.relative(ROOT, MANIFEST_PATH)}`);
    } else {
      console.error(`DIFFERS  ${path.relative(ROOT, MANIFEST_PATH)} — recorded hashes do not match freshly generated ones`);
      mismatches++;
    }
  }

  if (mismatches > 0) {
    console.error(`\n${mismatches} profile(s) diverged from the generator. Not behavior-preserving — fix before merging.`);
    process.exit(1);
  }
  console.log('\nAll generated profiles are byte-identical to the committed .claude/agents/*.md files.');
}

main();
