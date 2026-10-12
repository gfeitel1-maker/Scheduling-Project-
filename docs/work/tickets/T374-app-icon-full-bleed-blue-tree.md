---
title: T374-app-icon-full-bleed-blue-tree
document_type: ticket
status: closed
created: 2026-10-11
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
archive_when: build/icon.png and build/icon.icns show the blue sprout mark from public/favicon.svg full-bleed on navy, with no cream or white margin
---

# T374: app icon becomes the blue sprout, full-bleed

**Owner request (2026-10-11, verbatim intent):** replace the current app icon with the blue design used for the web favicon, a tree on a blue background, filling the icon instead of sitting inside a lot of white space.

**Done.** `build/icon.png` (1024px) and `build/icon.icns` are regenerated from the `public/favicon.svg` geometry:
- navy `#173B63` fills the whole square, with rounded corners and no margin;
- the gold sprout is scaled and centred to fill it.

The icns holds every size from 16 to 512 at @1x and @2x, and was built with `iconutil`. `public/favicon.svg` is unchanged. The PNG is used by `package.json` (electron-builder) and by `electron/main.js` (the BrowserWindow icon); both paths are unchanged.
