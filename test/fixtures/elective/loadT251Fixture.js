// Thin loader for the T251/T265 per-cell elective preference fixture. No
// transformation, no defaults — readFileSync + JSON.parse, nothing else, so a
// consumer sees exactly what scripts/fixtures/make-elective-cell-fixture.mjs
// wrote.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 't251-per-cell-preferences.json')

export function loadT251Fixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'))
}
