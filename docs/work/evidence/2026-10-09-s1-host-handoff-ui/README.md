# S1 host handoff — UI evidence (browser mock, layout only)

Captured with Playwright (Chromium) against `npm run dev` at localhost:5200, driving the browser mock
(`src/localClient.mock.js`) through `window.__mockShoresh._setHandoff(...)`. This is a layout/state
check only (the dev mock has no second device); the handoff itself is proven over real libp2p in
`electron/sync/automerge/hostHandoffWire.test.js`.

| File | State shown |
| --- | --- |
| 1-idle-eligible-row.png | Host, Devices screen: "Hand hosting to <device>" on the eligible (admin, LAN) row only |
| 2-progress-waiting-for-confirm.png | Inline progress on the control: "Waiting for <device> to confirm…" |
| 3-progress-sending.png | Inline progress: "Sending to <device>…" with the 2px bar |
| 4-result-did-not-complete.png | Result line on the control after a failure; the button is back for a retry |
| 5-not-host-control-hidden.png | Not the host: no control on any row |
| 6-successor-confirm.png | Successor: the one confirm, "<this computer> becomes the host for <camp>", both apps restart |
| 7-successor-waiting-for-old-host.png | Successor after the key is stored: waiting for the old host, no choice offered |
| 8-progress-reduced-motion-text-only.png | `prefers-reduced-motion: reduce`: same progress as text, no moving bar (0 `.shoresh-indeterminate-fill` elements) |
