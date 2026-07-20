# Auth & Onboarding Screens — Design Spec

**Date:** 2026-07-19
**Status:** Ready for Maker
**Depends on:** `docs/superpowers/specs/2026-07-19-local-first-desktop-architecture-design.md`
**Replaces:** the `DEV_CAMP_ID` bypass in `src/App.jsx`, and the Supabase-based `src/screens/AuthScreen.jsx`

## Context

The renderer currently skips real auth entirely — `App.jsx` hardcodes a `DEV_CAMP_ID` and renders straight into the app shell. The backend now supports the Host/Client local-first model (SQLite + PIN auth + mDNS discovery, per `2026-07-19-local-first-desktop-architecture-design.md`). This spec designs the three screens/states needed to route a real user from "app just launched" to "inside the app," replacing the dev bypass and the old Supabase `AuthScreen`.

Audience is a non-technical camp director or counselor — no assumption of familiarity with terms like "host," "client," "LAN," or "mDNS" beyond the plain-language framing given here.

## Screen sequence (state machine)

```
App launch
   │
   ├─ no mode configured on this machine ──────────────► [1] Mode Select
   │                                                            │
   │                                          "Host" chosen ────┼──► no camp exists yet ──► [2] First-Run Bootstrap ──► [3] Login
   │                                                            │         camp exists ─────────────────────────────────► [3] Login
   │                                          "Join" chosen ────┴──► discover Hosts ──► pick one ─────────────────────► [3] Login
   │
   └─ mode configured, camp exists, no active session ─────────────────────────────────────────────────────────────────► [3] Login
```

Once a session exists, the app renders `Shell` as today. Mode selection and bootstrap are one-time; login recurs every launch (and after logout/lock).

## Layout

All three screens reuse the same centered single-card shell already established by the current `AuthScreen.jsx` and `CampSetup.jsx`: a `flex` page container centered on `var(--bg)`, containing one `var(--surface)` card, `1px solid var(--border)`, `10px` radius, `40px 44px` padding, `max-width: 460–480px`. This is the existing "auth card" pattern — do not invent a new frame.

### 1. Mode Select
- Logo block (Shoresh wordmark + subtitle) at top, exactly as in current `AuthScreen`.
- Eyebrow: "First launch on this computer."
- Title: "How is this device being used?"
- One-paragraph subtitle explaining the stakes in plain language (this choice is sticky).
- Two full-width **choice cards**, stacked, not side-by-side radio buttons — this is a big, infrequent, consequential decision and deserves the same visual weight as the `CampSetup` step cards (icon left, title + description, chevron right, hover border highlight). Each card is a single button.
  - Card 1: "Host this camp's schedule" — star/anchor icon, description names who should pick this (the office computer / the one that stays on).
  - Card 2: "Join a camp already set up" — sync icon, description names who should pick this (staff laptops, other stations).
- No footer nav, no back button (this is the true entry point).

### 2. Join flow (sub-states of "Join" branch, before reaching Login)
- **Searching:** back button (to Mode Select) top-left, eyebrow "Join a camp," title "Looking for a camp on your network…", subtitle reminding the user to be on the same Wi-Fi, a centered spinner + "Searching…" row.
- **Found:** same header, list of discovered hosts as rows (`host-item`): live-status dot, camp name (bold), small mono metadata line (IP + device name), chevron. Tapping a row proceeds directly to Login for that Host — no separate "confirm" step, since picking IS the confirmation. A "Search again" link below the list for re-scanning.
- **Empty/not found:** back button, then a centered empty state: icon, bold title "No camps found nearby," a short bulleted checklist of the two most likely fixes (same Wi-Fi network; Host computer on and running Shoresh), and a primary "Search again" button.

### 3. First-Run Bootstrap (Host-only, camp doesn't exist yet)
- Back button to Mode Select (in case they picked Host by mistake).
- A small **role pill** badge ("HOSTING ON THIS DEVICE," teal dot) reinforces which path they're on — this screen and Login can otherwise look similar, so the pill disambiguates at a glance.
- Title: "Set up your camp." Subtitle clarifies this is one-time and more staff can be added later.
- Three fields, top to bottom: Camp name (text), Your name (text), Create a PIN (password, numeric-hinted, `4 or more digits` placeholder) with a hint line underneath explaining the PIN's purpose and that it doesn't need to be complex.
- Primary button: "Create camp & continue →". Disabled until all three fields pass minimum validation (camp name non-empty, name non-empty, PIN length ≥ 4).

### 4. Login
- Logo block, but subtitle swaps from the static "Camp activity scheduling" tagline to the **actual camp name** (e.g. "Camp Achva") once a camp is configured — this is a small but important trust signal that they're connecting to the right camp.
- Title: "Sign in." Two fields: Name (text), PIN (password, numeric-hinted).
- Primary button: "Sign in."
- **Error state (wrong PIN):** an inline `error-box` above the fields with a message that confirms the *name* matched but the PIN didn't ("That PIN doesn't match Sarah Cohen. Try again — you have a few attempts left."), plus four small PIN-position dots below the PIN field that flash red once on submit failure (see Animation) to give tactile, non-verbal feedback. Do not clear the Name field on error — only PIN.
- **Locked-out state:** both fields become disabled (dimmed, not hidden — the user should see their name is still there), and the error box is replaced by a distinct amber `lockout-box` (not red — this is not an alarm, it's a wait state) with a clock icon, title "Just a moment," a message that deliberately does **not** mention attempt counts or the word "locked"/"security lockout" verbatim in a way that reads as a warning to a would-be attacker, and a live mm:ss countdown. The Sign In button is disabled for the duration. When the countdown reaches 0, the screen returns automatically to the default enabled state (Maker: re-enable fields, clear PIN, refocus PIN field) — no user action required to "unlock."

## Visual Style

Matches existing Shoresh DNA exactly — no new tokens introduced.

- **Color:** `--primary` (#00ADBB teal) for all primary actions, focus states, active/status accents. `--bg` for page background, `--surface` for the card. `--border` (#E2E6E9-equivalent) for all hairlines. `--text` / `--text-secondary` for hierarchy. `--success` (green) only for the "online/found" status dot on discovered hosts. `--warning` (red, existing `#c0392b`/`#f5c6c6` error-box pairing) reserved for the wrong-PIN error only — **never** for the lockout state, which uses a separate amber pairing (`#fffaf0` / `#f5deb0` / `#8a6110`) to visually signal "wait, not broken."
- **Typography:** `var(--font-condensed)` for the wordmark, all titles, choice-card titles, and eyebrows (bold, tight tracking, matches `CampSetup`'s `26px`/`700`/`-0.3px` heading pattern, scaled down to `19–22px` for these narrower cards). `var(--font-mono)` for the logo subtitle, metadata (host IP/device name, countdown timer, role pill) — mono is already the established convention for "small system-status text" (see `CampSetup`'s progress counter, saved-indicator). `var(--font-sans)` (inherited) for body copy and form values.
- **Shape:** `7–10px` border-radius throughout, consistent with the app's existing button/card/input radii (`S.btnPrimary` uses `7px`, `CampSetup` cards use `10px`).
- **Elevation:** Cards get a very soft ambient shadow (`0 2px 24px rgba(20,30,40,0.06)`) since these screens have no sidebar/topbar chrome around them to anchor the card visually — slightly more than the flat `AuthScreen` card today, matching the `isActive` step-card shadow already used in `CampSetup`.

## States

| Screen | States |
|---|---|
| Mode Select | default (only state — no loading, this is instant) |
| Join | searching → found (list) → empty (not found); "search again" loops back to searching from either found or empty |
| Bootstrap | default → submitting (button label swaps to "Creating…", disabled, matches existing `loading` button pattern in old `AuthScreen`/`CampSetup`'s "Saving…") → error (validation or write failure, reuse `S.errorBanner`/`error-box` styling) |
| Login | default → submitting ("Signing in…") → error (wrong PIN) → locked (post-5th failure) → back to default automatically on unlock or on successful retry |

## Interactions

- Choice cards, host rows, and step buttons all share the existing hover treatment from `CampSetup`: border shifts to `var(--primary)`, subtle shadow appears, no layout shift.
- Back buttons are plain-text with a hover background (`var(--border)`) — same weight as a secondary action, never styled as a primary button, since going back is common and low-stakes here.
- All primary buttons disable (opacity 0.4, `not-allowed` cursor) until their form is valid — this mirrors `CampSetup`'s CTA-disable pattern exactly (`opacity: allDone ? 1 : 0.35`).
- Selecting a discovered Host in the "found" list navigates directly into Login for that Host — no intermediate confirm dialog, since a wrong tap just lands you on a login screen showing the wrong camp name, which is self-correcting (back button) rather than destructive.
- PIN fields use `type="password"` with numeric-friendly styling (letter-spaced, larger touch target) but are plain text inputs, not segmented OTP boxes — keep form complexity low, this app is used on trackpads/keyboards, not phones.

## Animation

Keep motion minimal and functional, consistent with the app's existing restraint (the only current motion is the `CampSetup` progress-bar width transition and card hover shadows).

- **Card hover:** `border-color 0.15s, box-shadow 0.15s` — reuse verbatim from `CampSetup` step cards.
- **Searching spinner:** simple CSS `border-top-color` spin, `0.8s linear infinite`, small (18px) — utilitarian, not decorative.
- **Wrong-PIN feedback:** the four PIN-position dots briefly flash red and do a small horizontal shake (`translateX(-3px)/(3px)`, `0.35s`) on submit failure — this is the one moment on these screens that should feel slightly more expressive, since it's the app's only non-verbal "no" signal and needs to register before the user rereads the error text.
- **Lockout countdown:** numeric only, no progress ring or animated fill — a static amber box with a ticking mm:ss number is calmer than a shrinking bar, which would read as more alarming than intended.
- **Screen transitions:** none specified (instant swap) — these are infrequent, one-directional navigations; adding transition choreography would be effort spent where the user won't be looking twice.

## Prototype

`docs/superpowers/specs/prototypes/2026-07-19-auth-onboarding-prototype.html`

Single self-contained HTML file covering all 8 states via an in-page state switcher (dark top bar with buttons — prototype-only chrome, not part of the shipped UI): `mode-select`, `join-searching`, `join-found`, `join-empty`, `bootstrap`, `login`, `login-wrong`, `login-locked`. Buttons at the bottom of the searching/default-login cards labeled "(proto: …)" simulate the state transitions a real async event would drive (found/not-found/wrong-PIN/locked) — Maker should treat those as stand-ins for the real event handlers, not as UI to ship. Open directly in a browser; no build step or dependencies.

## Implementation Notes for Maker

- **File placement:** suggest `src/screens/ModeSelectScreen.jsx`, `src/screens/JoinScreen.jsx` (owns all three join sub-states as local `useState`), `src/screens/CampBootstrapScreen.jsx`, and a rewritten `src/screens/LoginScreen.jsx` replacing `src/screens/AuthScreen.jsx`. Delete the Supabase-specific `AuthScreen.jsx` and its `email`/`password`/sign-up-tab logic entirely — none of it applies to PIN auth.
- **Shared styles:** pull the card/page/button/input primitives that repeat across all four screens into `src/styles/shared.js` (`S.authPage`, `S.authCard`, `S.field`, etc.) rather than redefining per-file — the current `AuthScreen.jsx` already half-does this with bottom-of-file consts; consolidate into `S` this time since four screens now share the pattern instead of one.
- **`App.jsx` routing:** replace the `DEV_CAMP_ID` bypass with a small state machine driven by whatever `useLocalAuth()`/`useDeviceMode()` hook Maker builds against the `auth-local` component described in the architecture spec: `no-mode → ModeSelectScreen`, `host + no-camp → CampBootstrapScreen`, `configured + no-session → LoginScreen`, `configured + session → Shell`. Mirror the existing `useSession()` gating shape referenced in `CLAUDE.md` as closely as possible so the rest of the app (which expects `campId` as a prop) doesn't need to change.
- **Discovery wiring:** `JoinScreen`'s "searching" state calls `localClient.discoverHosts()` on mount (per the brief, returns `[{name, host, port}]`); empty array after a timeout (suggest ~5s, Maker's call) → empty state; non-empty → found state. "Search again" simply re-invokes discovery and returns to the searching state.
- **PIN input:** do not build a custom segmented/OTP component — a single password-type `<input>` is sufficient and matches the rest of the app's plain-form-field convention. The four dots shown in the wrong-PIN error state are decorative feedback, not the input itself.
- **Lockout timing:** the backend enforces 5 attempts / 30s lockout (per architecture spec's "standard retry/lockout" note) — Maker should surface whatever remaining-seconds value the auth layer returns rather than hardcoding 30s client-side, in case the policy changes; the prototype's `0:24` starting value is illustrative only.
- **Copy tone:** keep all copy in plain, non-technical language per the brief — avoid "Host/Client," "mDNS," "sync," "node," etc. in user-facing strings; those terms are fine in code/comments but not in the UI. The prototype's copy is close to final; Maker can use it near-verbatim.
- **Accessibility:** ensure `autoFocus` lands on the first meaningful field per screen (Name on Login, Camp name on Bootstrap), matching the existing `AuthScreen`/`CampSetup` convention of auto-focusing the primary input.
