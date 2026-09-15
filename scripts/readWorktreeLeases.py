#!/usr/bin/env python3
"""Read Claude Desktop's worktree ledger and print the paths it still tracks, one per line.

Extracted from an inline heredoc in scripts/integration.sh so it can be tested (T168). That
script PRUNES — deletes — worktree directories, and this is the only thing standing between the
prune rule and a pooled worktree the application still expects to reuse.

The ledger is application-owned state: read only, never written.

Exit codes are the contract, and the distinction matters more than the output:
  0  parsed, shape recognised — stdout is zero or more paths
  3  unreadable: absent, truncated, or read mid-write
  4  parsed fine, but there is no `worktrees` object — the schema moved

3 and 4 exist because `d.get("worktrees") or {}` silently yields {} on a renamed key, which logs
identically to a healthy ledger with nothing leased. That would reinstate the exact silent failure
this guard was added to prevent, and nothing would ever notice. (Red Hat, 44b49c6.)
"""
import json
import sys


def lease_paths(doc):
    """Paths in the ledger. Raises KeyError if the shape is not recognised."""
    trees = doc.get("worktrees")
    if not isinstance(trees, dict):
        raise KeyError("worktrees")
    out = []
    for entry in trees.values():
        if not isinstance(entry, dict):
            continue
        path = entry.get("path")
        if isinstance(path, str) and path:
            out.append(path)
    return out


def main(argv):
    if len(argv) < 2:
        return 3
    try:
        with open(argv[1], encoding="utf-8") as fh:
            doc = json.load(fh)
    except Exception:
        return 3
    try:
        paths = lease_paths(doc)
    except KeyError:
        return 4
    for p in paths:
        print(p)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
