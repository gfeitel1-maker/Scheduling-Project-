# Identity & permissions for a Host-less camp — design sketch

**Conceptual, isolated, not an implementation.** The gating open question from the ADR:
*with no permanent Host acting as notary, who is allowed into a camp, and how are keys
handed out and taken away?* Written for a non-engineer. Recommends one design, states
what it reuses, and is honest about the hard edges.

---

## The problem in one paragraph

Today the **Host** does two identity jobs: it is the **notary** (it holds a private key
and stamps "this login is valid for Camp Achva") and the **gatekeeper** (a new laptop
asks the Host to pair, and the Host approves or denies). Both jobs assume an always-on
Host on the network. In a Host-less world — where changes may travel through a dumb
shared folder and any laptop can be offline — there is no one to ask at the moment of a
change. So authority can no longer be *"ask the server right now."* It has to become
*"the change carries its own proof, and every laptop can check that proof by itself,
even offline."*

## What we are actually protecting (proportionate threat model)

Be honest about the stakes so we don't over-build:

- **Real goals:** only the director and their trusted staff can open and edit a camp;
  changes are attributable ("Taylor moved Pottery"); a departed staffer can be removed;
  a lost laptop doesn't hand the camp to a stranger.
- **Not goals:** defending against a determined attacker who already has write access to
  the camp's shared folder, or against nation-state forgery. Camp schedules are not
  secret intelligence. (Prior finding: PII is not a concern here.)
- **Consequence:** we want *understandable* integrity and membership, not a maximal
  cryptographic fortress. Complexity must earn its place, same as everywhere else.

## The key insight: there are TWO gates, and only one lives in Shoresh

| Gate | Who controls it | What it decides |
|---|---|---|
| **Folder access** (coarse) | The camp, via OneDrive/Dropbox/NAS sharing — **outside Shoresh** | Who can see/copy the raw project bytes at all |
| **Membership** (fine) | **Shoresh's own model** | Who can author *valid changes*, at what role |

This split does a lot of work. Shoresh does **not** try to be an access-control system for
files — the provider already is one. Shoresh owns the *fine* gate: even among people who
can reach the folder, only members can make changes the other laptops will accept. Keeping
these separate is what stops the identity model from ballooning.

---

## Recommended model

> **Locked decisions (owner, 2026-08-17):** **D1** integrity-only v1 (no encryption yet).
> **D2** a **person** is the identity, with **multiple devices** under them. **D3** owner
> resilience leans on the multiple-devices design (see the note in §1 and the hard edges).

### 1. A person is the member; their devices are enrolled under them
Each laptop still generates its own **Ed25519 keypair** (Shoresh already uses Ed25519), and
**that private key never leaves the laptop.** But a device key is not the member — it's one
of the **hands of a person**. A **person** ("Taylor") is the member, carries the role, and
owns a set of **enrolled device keys**. The camp **PIN is unchanged for staff** — it now
**unlocks that laptop's private key** locally.

- **A change is signed by whichever device made it**; peers verify *device key → person →
  role*. Any of Taylor's laptops produces changes that count as "Taylor."
- **Roles attach to the person, not the device.** Promote Taylor to owner and *all* Taylor's
  devices become owner-capable at once.
- **Enrolling your own second device is self-service:** a laptop you've *already* enrolled
  signs "add device Y under me." You don't need the director for your own iPad — you vouch
  for it with a device you already control. (An owner can also enroll a device for someone.)

*Why this is better than device-as-identity (your call):* the roster reads as **people**
("Taylor"), not "Taylor's MacBook + Taylor's iPad" as two strangers; roles are set once per
person; and **removing someone is one action that takes out all their devices at once**
(§ hard edges). The cost is one extra binding layer (person ↔ devices), which is worth it.

### 2. Creating a camp mints the root of trust
When a director creates **Camp Achva — Summer 2027**, their device key becomes the founding
**owner**. Shoresh writes a **genesis record** — {name, season, founding owner public
key(s), created date} — **signed by the owner's private key**. The project's true identity
is the fingerprint of that signed genesis. **A folder can hold a fake copy, but without the
owner's private key nobody can forge a valid genesis**, so other members' laptops won't
accept an imposter project.

### 3. Membership is a signed ledger — part of the same operation log
Who's allowed is not a server setting; it's a short, **self-verifying history** that rides
the normal operation stream:

```
GENESIS         person=Greg  owner   device=Greg-laptop     (signed by Greg-laptop)
ADD    person   Taylor       editor  device=Taylor-mac      (signed by Greg, an owner)
ENROLL device   Taylor-ipad  under person=Taylor            (signed by Taylor-mac, self-service)
ADD    person   Sam          viewer  device=Sam-pc          (signed by Greg)
PROMOTE person   Taylor -> owner                            (signed by Greg)
REVOKE person    Sam                                         (signed by Taylor, now an owner)
REVOKE device    Taylor-ipad (lost)   person Taylor stays    (signed by Taylor-mac)
```

Every laptop replays these signed entries from genesis and independently computes **"which
*people* are members right now, at what role, and which device keys belong to each."** The
signatures *are* the authority — no Host, no cloud, works offline. Two kinds of entry:
**person-level** (add/remove/role — only an owner may sign) and **device-level** (enroll/revoke
a device under a person — that person's existing device, or an owner, may sign). Any entry not
signed by an allowed key is ignored.

### 4. Every change is signed; peers verify it on arrival
When Greg moves Archery, the operation carries **Greg's signature**. Any laptop that
receives it checks, entirely locally: (a) the signature is valid, and (b) Greg's key is a
**current member with a role allowed to make that change**. A change from a non-member or a
revoked key is **rejected** — it never enters the schedule. This is the heart of the shift:
**authority travels *with the change*, not with a live server.** It's exactly what lets a
dumb folder be a safe transport.

### 5. Roles: keep it to three
- **Owner** (director): can add/remove members and change roles; everything editors can do.
  The root of trust. **There should be more than one** (see hard edges).
- **Editor** (staff): makes normal changes.
- **Viewer** (optional): read-only.

No permission matrix. Three roles cover the camp reality.

---

## The everyday flows (what a director actually does)

- **Start a camp:** create the project → you're the owner (as a *person*, with your first
  laptop enrolled). Done.
- **Add a staffer (offline/async, no live connection needed):** the staffer installs Shoresh,
  which shows their laptop's **public key as a short code / QR**. They send it to you any way
  at all — in person, text, email. You tap **Add → Editor** and give them a name. Shoresh emits
  a signed `ADD person` entry that propagates over whatever transport is available. When it
  reaches their laptop (with the project data via folder/relay), they're in. *The only thing
  exchanged is a public key, which is safe to send in the clear.*
- **Add your own second device:** on the new laptop, Shoresh shows its key; on a laptop you
  already use, you tap **"This is also me."** Your existing device signs the enrollment — no
  director needed.
- **Make a change:** just work. Shoresh signs each change with that laptop's key automatically.
- **Remove a staffer:** tap **Remove** on the *person* → one signed `REVOKE person` takes out
  all their devices at once. Shoresh then reminds you in plain words to also remove them from
  the shared folder.

---

## The hard edges (told straight)

1. **Revocation is forward-looking and not instant.** A `REVOKE` only takes effect on a
   laptop once it *arrives* there. Over a slow folder that could be minutes or hours, during
   which the removed person's already-authored changes may still land. For "staffer left,
   remove their access," that lag is acceptable. It is **not** a defense against a hostile
   insider racing you in real time — and it doesn't need to be, per the threat model.
2. **Shoresh's `REVOKE` does not remove *folder* access.** If the removed person still has
   write access to the shared OneDrive/NAS folder, they can still delete or scramble files
   there — that's the *coarse* gate, and the camp must close it in their provider. Shoresh
   should **tell the director this in plain words** at removal time ("Also remove them from
   the shared folder"), not pretend a Remove tap is the whole story.
3. **Losing an owner — now softened by the person model, but not eliminated (your D3).**
   Because a *person* can enroll **multiple devices**, an owner who loses one laptop is fine:
   they still administer the camp from another enrolled device. **This is the resilience your
   "see previous answer" points to, and it works — *if the owner actually enrolled a second
   device.*** The residual risk is losing the *whole person* (only one owner, only one device,
   and it dies / they leave): administration is then bricked, though everyone else keeps
   working. **Recommendation:** Shoresh should **nudge every owner to enroll a second device**
   at setup, and for a lone director, **strongly suggest naming a co-owner** (or exporting an
   encrypted recovery key). Whether to *require* ≥2 owner-devices or merely *nudge* is the one
   piece of D3 still worth your explicit call.
4. **Lost device / new laptop:** the person **revokes the lost device** and **enrolls the new
   one from another device they already have** — no re-onboarding by the director, and their
   role/history carry over because the *person* is unchanged. (If it was their *only* device,
   they re-onboard as in "add a staffer.") No data is lost — it's in the folder/other laptops.
5. **A revoked key forging an old timestamp** to sneak a late change in "before" its revoke:
   possible in theory with logical clocks, out of scope for a camp in practice. Genuinely
   concurrent changes (made before seeing the revoke) are honored, matching the
   understandable-conflict philosophy. Worth a note in the eventual spec, not a redesign.

## Encryption: deferred on purpose

Signing gives **integrity + attribution** (you know a change is real and who made it) but
**not secrecy** — anyone with folder access can still *read* the project. To make membership
also gate *reading*, the operations would need to be **encrypted** with a project key shared
only among members (handed to each new member as a "sealed envelope" encrypted to their
public key). That's real added complexity (key distribution, re-keying on removal).

**Recommendation: ship integrity-only first.** For most camps, folder access already implies
"authorized to see," and the data isn't sensitive. Offer encryption later *only* if a camp
has a real confidentiality need. Don't pay for it up front.

---

## What this reuses from today's Shoresh (evolution, not rebuild)

- **Ed25519 signing** — already used for camp tokens (`host_signing_key`); repurpose per-device.
- **Per-device identity** — `device_identity` / device keys already exist.
- **Roles** — the `users` table already carries roles; map to owner/editor/viewer.
- **The pairing UX** (approve/deny/revoke a device) — becomes "add/remove member," same shape.
- **`authorize()` re-checking on every change** — becomes "verify signature + current
  membership on every applied change," same instinct, now offline-capable.

The change in principle: **from "the Host vouches at runtime" to "changes are self-proving and
membership is a signed, replicated ledger rooted in owner keys."**

## Alternatives considered (and why not)

- **One shared camp passphrase** (everyone with the passphrase + folder is in). *Rejected:*
  no per-person attribution, and you can't remove one staffer without re-keying everyone —
  staff turnover makes that painful. Too weak on exactly the two things camps need.
- **A cloud identity provider / accounts** (Google/Microsoft sign-in). *Rejected:* reintroduces
  the mandatory-internet dependency the whole investigation is avoiding, and puts identity in a
  vendor. Overkill for a handful of camp staff.
- **Keep a permanent Host purely as notary.** *Rejected as the default:* recreates the
  always-on-server requirement we're removing. (A relay may exist for *liveness*, but it must
  stay a data-less switchboard — making it the identity authority would quietly turn it back
  into a backend.)

## Confidence & the decisions that are yours to make

**Confidence:** high that this is proportionate, offline-capable, cloud-free, and reuses
Shoresh's existing primitives; the model is a well-trodden pattern (signed membership ledger +
signed ops), not novel cryptography. Medium on the exact onboarding UX and the recovery story —
those want a real design pass before code.

**Owner decisions — status:**
- **D1 — Secrecy:** ✅ **LOCKED: integrity-only v1**, encryption deferred.
- **D2 — Identity unit:** ✅ **LOCKED: person, with multiple devices under them.** Model above
  revised accordingly (person-level roster + device enrollment).
- **D3 — Owner resilience:** ✅ **LOCKED.** Multiple-devices-per-person handles device loss.
  For a lone director, Shoresh **nudges hard but does not hard-block** — it strongly prompts
  enrolling a second owner-device (or naming a co-owner / exporting a recovery key), but never
  blocks a solo director from getting started.
