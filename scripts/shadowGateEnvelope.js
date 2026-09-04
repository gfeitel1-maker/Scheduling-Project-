#!/usr/bin/env node
// Phase 4 (shadow only) — runs the same eight deterministic scenarios the
// Phase 0 audit already validated the real reducer against, through the real
// unmodified reduceGateReport(), then projects each result through the
// proposed TaskRun envelope (taskEnvelopeSchema.js) and reports both side by
// side. Read-only, in-memory: no file writes, no change to
// docs/work/runs/gate-reports/, no call into gateReportCli.js or
// gateReportPersist.js. This is a shadow comparison, never a gate.
//
// See docs/adr/2026-09-04-portable-agent-team-compatibility-layer.md
// "Phase 4 (shadow mode)".

import { reduceGateReport } from './gateReportReduce.js'
import { validateTaskRunShape, projectTaskRunStatus } from './taskEnvelopeSchema.js'

const baseTaskRun = {
  taskId: 'SHADOW-1',
  round: 1,
  baseCommit: '0000000000000000000000000000000000000000',
  candidateRef: '1111111111111111111111111111111111111111',
  selectedRoles: ['verifier', 'security', 'red_hat', 'tester', 'code_reviewer'],
  omissions: [],
}

const pass = (gate, score = 5) => ({
  gate_name: gate,
  verdict: 'PASS',
  score: gate === 'verifier' ? null : score,
  na_reason: null,
  findings: [],
  evidence_ref: gate === 'verifier' ? 'evidence' : null,
})
const opinionExpected = ['security', 'red_hat', 'tester', 'code_reviewer']

const scenarios = [
  {
    label: 'Verifier PASS + expected Security 5',
    round: 1,
    expectedOpinionGates: ['security'],
    reports: [pass('verifier'), pass('security', 5)],
  },
  {
    label: 'Above, plus expected Tester missing',
    round: 1,
    expectedOpinionGates: ['security', 'tester'],
    reports: [pass('verifier'), pass('security', 5)],
  },
  {
    label: 'Missing Verifier',
    round: 1,
    expectedOpinionGates: ['security'],
    reports: [pass('security', 5)],
  },
  {
    label: 'Verifier UNVERIFIED',
    round: 1,
    expectedOpinionGates: ['security'],
    reports: [{ gate_name: 'verifier', verdict: 'UNVERIFIED', score: null, na_reason: null, findings: [], evidence_ref: 'evidence' }, pass('security', 5)],
  },
  {
    label: 'Opinion FAIL with BLOCKING finding',
    round: 1,
    expectedOpinionGates: ['security'],
    reports: [pass('verifier'), { gate_name: 'security', verdict: 'FAIL', score: 1, na_reason: null, findings: [{ severity: 'BLOCKING', summary: 'x', ref: null }], evidence_ref: null }],
  },
  {
    label: 'Unexpected opinion report',
    round: 1,
    expectedOpinionGates: [],
    reports: [pass('verifier'), pass('security', 5)],
  },
  {
    label: 'Duplicate opinion report',
    round: 1,
    expectedOpinionGates: ['security'],
    reports: [pass('verifier'), pass('security', 5), pass('security', 4)],
  },
  {
    label: 'All expected opinions missing',
    round: 1,
    expectedOpinionGates: opinionExpected,
    reports: [pass('verifier')],
  },
  {
    label: 'Round-2 BLOCK escalates',
    round: 2,
    expectedOpinionGates: ['security'],
    reports: [pass('verifier'), { gate_name: 'security', verdict: 'FAIL', score: 1, na_reason: null, findings: [{ severity: 'BLOCKING', summary: 'x', ref: null }], evidence_ref: null }],
  },
]

let failures = 0

for (const scenario of scenarios) {
  const taskRun = { ...baseTaskRun, round: scenario.round }
  const shapeCheck = validateTaskRunShape(taskRun)
  if (shapeCheck.malformed) {
    console.error(`ENVELOPE SHAPE INVALID for "${scenario.label}": ${shapeCheck.problem}`)
    failures++
    continue
  }

  const gateReport = reduceGateReport({
    taskId: taskRun.taskId,
    round: scenario.round,
    expectedOpinionGates: scenario.expectedOpinionGates,
    reports: scenario.reports,
  })

  const projected = projectTaskRunStatus(gateReport, 2)

  console.log(`${scenario.label}`)
  console.log(`  reducer: decision_eligibility=${gateReport.decision_eligibility} incomplete=${gateReport.incomplete}`)
  console.log(`  envelope: status=${projected.status} pending_human_decision=${projected.pending_human_decision}`)
  console.log('')
}

if (failures > 0) {
  console.error(`${failures} scenario(s) produced an invalid envelope shape.`)
  process.exit(1)
}
console.log('All scenarios: envelope shape valid, reducer output projected without touching the reducer, its schema, or its persistence.')
