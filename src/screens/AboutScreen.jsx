import { useEnterTransition } from '../styles/shared'

// About & Legal — one co-located surface reached from the sidebar footer,
// holding everything a director might want to look up but never has to act on:
// a short About note, the app version, the user agreement, the open-source
// license, and a pointer to the bundled third-party attributions.
//
// Deliberately VIEW-ONLY (owner ruling 2026-10-02: ship minimal + done). There
// is no first-run "I understand" gate and no stored acceptance state — the
// agreement is simply always readable here. Pure UI: no schema, no sync, no
// auth, no IPC. An accept-gate, the owner's personal About words, and any
// user-agreement polish (voice, legal review) are the follow-up ticket's job.

// Kept in step with package.json's "version" by hand — the sidebar footer
// carries the same literal. The follow-up may source both from one place.
const APP_VERSION = '0.1.0'

// DRAFT user agreement, shipped as-is per the owner's ruling. Plain-language and
// local-first-honest; the terms remain the owner's and are revisited in the
// follow-up ticket.
const USER_AGREEMENT_INTRO =
  'Shoresh is a scheduling tool for camps. Please read this before you use it.'

const USER_AGREEMENT_POINTS = [
  {
    heading: 'It runs on your own devices.',
    body:
      'Shoresh has no accounts and no servers. It does not send your camp’s ' +
      'information anywhere. Everything you enter lives on the device you enter it ' +
      'on. When you connect a second device to the same camp, the two devices share ' +
      'that camp’s information directly with each other over your local network ' +
      '— it still never passes through anyone else’s computer, and not through us.',
  },
  {
    heading: 'You are responsible for the information you put in.',
    body:
      'That includes any details about campers and staff. Keep your devices secure, ' +
      'and share a camp code only with people you mean to let in. Shoresh helps you ' +
      'organize this information; it does not decide who should see it.',
  },
  {
    heading: 'It is free and open source.',
    body:
      'Shoresh is released under the Apache License 2.0. You are free to use it, run ' +
      'it, and adapt it for your camp. The full license and the licenses of the ' +
      'software Shoresh is built from are shown below.',
  },
  {
    heading: 'It comes with no warranty.',
    body:
      'Shoresh is provided “as is,” without warranty of any kind. We do our ' +
      'best to make it correct and reliable, but you use it at your own risk, and we ' +
      'are not liable for any loss that results from using it. Always keep your own ' +
      'record of anything you cannot afford to lose.',
  },
  {
    heading: 'No one is watching.',
    body:
      'Shoresh collects no analytics, no usage data, and no personal information. ' +
      'There is nothing to opt out of, because there is nothing being gathered.',
  },
]

// The standard Apache-2.0 short notice. The complete license text ships with
// Shoresh in the repository-root LICENSE file.
const APACHE_NOTICE =
  'Copyright 2026 Gregory Feitel and contributors.\n\n' +
  'Licensed under the Apache License, Version 2.0 (the “License”); you may ' +
  'not use this software except in compliance with the License. You may obtain a ' +
  'copy of the License at http://www.apache.org/licenses/LICENSE-2.0.\n\n' +
  'Unless required by applicable law or agreed to in writing, software distributed ' +
  'under the License is distributed on an “AS IS” BASIS, WITHOUT WARRANTIES ' +
  'OR CONDITIONS OF ANY KIND, either express or implied. See the License for the ' +
  'specific language governing permissions and limitations under the License.'

// Mirrors the repository-root NOTICE file.
const THIRD_PARTY_NOTE =
  'Every third-party dependency and its full license text ships with the app ' +
  'as third-party-licenses.html.'

export default function AboutScreen() {
  const enter = useEnterTransition('slideFade', {})

  return (
    <div style={{ ...styles.page, ...enter }}>
      <h1 style={styles.title}>About &amp; Legal</h1>

      {/* About — neutral placeholder. The owner's personal note ("something of
          me") is added in the follow-up ticket; nothing is invented here. */}
      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>About</h2>
        <p style={styles.meta}>Version {APP_VERSION}</p>
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>User agreement</h2>
        <p style={styles.body}>{USER_AGREEMENT_INTRO}</p>
        <div style={{ marginTop: 12 }}>
          {USER_AGREEMENT_POINTS.map((point) => (
            <div key={point.heading} style={styles.point}>
              <div style={styles.pointHeading}>{point.heading}</div>
              <p style={styles.body}>{point.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>License</h2>
        <pre style={styles.licenseText}>{APACHE_NOTICE}</pre>
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Third-party software</h2>
        <p style={styles.body}>{THIRD_PARTY_NOTE}</p>
      </section>
    </div>
  )
}

const styles = {
  page: {
    maxWidth: 720,
    paddingBottom: 48,
  },
  title: {
    fontSize: 22,
    fontWeight: 700,
    color: 'var(--text)',
    margin: '0 0 24px',
  },
  section: {
    marginBottom: 28,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--text)',
    margin: '0 0 8px',
  },
  body: {
    fontSize: 13,
    lineHeight: 1.6,
    color: 'var(--text-secondary)',
    margin: '0 0 4px',
  },
  meta: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    opacity: 0.8,
    margin: '8px 0 0',
    fontFamily: 'var(--font-mono)',
  },
  point: {
    marginBottom: 14,
  },
  pointHeading: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text)',
    marginBottom: 2,
  },
  licenseText: {
    marginTop: 10,
    padding: 14,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    fontSize: 12,
    lineHeight: 1.6,
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)',
    whiteSpace: 'pre-wrap',
    overflowX: 'auto',
  },
}
