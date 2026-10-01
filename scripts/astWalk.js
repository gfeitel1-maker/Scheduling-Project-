// Generic recursive walker over acorn AST nodes, shared by staleSettingsKey.js
// and vacuousFilterAssertion.js so the traversal itself does not exist twice.
// No new dependency (acorn-walk) — this is the ~15 lines it would take.

export function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return
  visit(node)
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value) walk(item, visit)
    } else if (value && typeof value.type === 'string') {
      walk(value, visit)
    }
  }
}
