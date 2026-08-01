# Pixl Pisonet App

A Windows Electron kiosk client for a pisonet / cybercafe. Supabase is the source
of truth; a per-PC SQLite cache keeps things working offline. The app has three
modes: a fullscreen **lockscreen**, an **active session** that lives in the system
tray, and an **admin panel** for managing accounts and time credits. A Windows
service **watchdog** relaunches the app if it is killed.

## Requirements

- Windows 10/11
- Node.js 20+ (built and tested on Node 24) and npm
- No C++ build tools needed: `better-sqlite3` is pinned to a version with a
  prebuilt binary for the bundled Electron ABI.

## Setup

```powershell
npm install
npm run rebuild        # fetches the better-sqlite3 prebuilt binary for Electron
copy .env.example .env # then fill in SUPABASE_URL and SUPABASE_ANON_KEY
```

> If `npm run rebuild` cannot download a prebuild (offline, or a new Electron
> version with no published prebuild), install Python 3 + "Desktop development
> with C++" (Visual Studio Build Tools) and run `npx electron-rebuild -f -w better-sqlite3`.

## Run

```powershell
npm run dev            # launch in development (hot reload). Auto-shutdown is disabled in dev.
npm run build          # typecheck + build main/preload/renderer into out/
npm run start          # preview the production build locally
npm run package:win    # build a Windows NSIS installer into release/
```

Dev mode sets `PIXL_NO_SHUTDOWN=1` automatically so the idle timer never powers
off your machine while developing. Auto-update (`electron-updater`) is a no-op
in unpackaged/dev builds — only the NSIS-installed app checks GitHub Releases.

## Shipping updates (GitHub Releases)

App version is **`package.json` `version`**, exposed at runtime via
`app.getVersion()`. Cafe PCs pull updates from **GitHub Releases** on
[Chibiby/pixl-app](https://github.com/Chibiby/pixl-app) (see `build.publish` in
`package.json`). Tag names must match semver as `vX.Y.Z` (e.g. `v0.1.0`).

On idle lockscreen (no active client session), packaged builds check in the
background, download quietly, and quit-and-install when still safe. Admins can
also use **Check for updates** / **Update now** in the Admin Panel sidebar
(shows current version + status). Active paid sessions are never interrupted.

### Cut a release

```powershell
# 1. Bump version in package.json (semver), commit, push
# 2. Tag to match (leading v)
git tag v0.1.0
git push origin v0.1.0

# 3. Build the Windows installer (+ latest.yml for electron-updater)
npm run package:win

# 4. Publish a GitHub Release for that tag and upload release\ artifacts:
#    - Pixl Setup x.y.z.exe (NSIS installer)
#    - latest.yml (and .blockmap if present)
gh release create v0.1.0 --title "v0.1.0" --generate-notes `
  "release/Pixl Setup 0.1.0.exe" `
  "release/latest.yml"
# Include *.blockmap if electron-builder emitted them.
```

Alternatively, with a GitHub token that can publish releases:

```powershell
$env:GH_TOKEN = "<token with repo scope>"
npm run package:win -- --publish always
```

After the Release is public, idle cafe PCs (or Admin → **Check for updates**)
pick it up on the next check. Deep Freeze / similar: thaw before installing an
update, then freeze again when stable.

## Configuration (`.env`)

| Key                  | Meaning                                                        |
| -------------------- | ------------------------------------------------------------- |
| `SUPABASE_URL`       | Your Supabase project URL                                     |
| `SUPABASE_ANON_KEY`  | Anon public key (client only ever calls whitelisted RPCs)     |
| `PIXL_PC_NAME`       | Friendly name for this PC (defaults to the Windows hostname)  |
| `PIXL_ADMIN_MACHINE` | `1` on the owner's machine → disables idle auto-shutdown here |

If Supabase is not configured, the app runs **fully offline** against the local
SQLite cache (unlimited offline grace, per the plan).

## Balance model

An account carries **two integer balances**:

| Column                 | Unit     | Meaning                                             |
| ---------------------- | -------- | --------------------------------------------------- |
| `credits_centavos`     | centavos | Money on the account. Admins top this up at the counter. |
| `time_balance_seconds` | seconds  | Play time the customer already bought with money.   |

Money is never stored as a float. `pesoToSecondsRate` (default `360`, i.e.
₱1 = 6 minutes) is the single conversion rate between the two.

A session runs in one of two modes, chosen on the lockscreen:

- **Timed** — counts down `time_balance_seconds`. The customer buys time with
  credits (presets ₱1 / ₱5 / ₱10, or any custom amount; `seconds = centavos ×
  rate ÷ 100`), either up front or mid-session from the tray. Logging out early
  leaves the unused time on the account. Money is never touched.
- **Open time** — burns `credits_centavos` continuously at the same rate. The
  per-second cost (`100 ÷ rate` centavos) is fractional, so it is accumulated
  in memory and only **whole centavos** are ever written to the database; the
  remainder carries to the next tick, so nothing is lost to rounding. The drain
  stops the instant the session ends.

Both modes fire the configured reminder thresholds (the money runway is
converted to seconds for the comparison) and auto-lock when the relevant
balance reaches zero.

Every movement of money or time is one row in the unified `credit_ledger`
(`kind`, `delta_centavos`, `delta_seconds`, monotonic `seq`).

## Supabase RPC surface

Client PCs never get table write access; all mutations go through SECURITY
DEFINER Postgres RPCs with strict RLS. The anon key alone cannot alter balances.

> **Status:** the deployed server predates the money model and stores a single
> seconds balance. The client is offline-first and treats its local SQLite cache
> as authoritative for balances, so it is fully correct without any of this.
> `debit_session_time` and `heartbeat` are used as-is today; the money RPCs
> below are written client-side but stay dormant behind `MONEY_RPCS_DEPLOYED`
> in `electron/sync/supabase.ts` until the server ships them. Flip that flag
> once the functions exist.

### Contract the server needs

| Function | Signature | Purpose |
| --- | --- | --- |
| `login_account` | `(p_username text, p_password text, p_machine_id text)` | Verify the bcrypt hash, enforce single-session-per-account, open a session. Must return **both** balances: `account {id, display_name, role, password_hash, credits_centavos, time_balance_seconds}`, plus `session_id` and `pc_id`. |
| `upsert_account` | `(p_id uuid, p_username text, p_password_hash text, p_role text, p_display_name text, p_credits_centavos int, p_time_balance_seconds int)` | Insert/update by case-normalized username so offline/admin-created accounts sync online. |
| `debit_session_time` | `(p_session_id uuid, p_seconds int, p_pc_seq bigint, p_synced_from text)` | Timed-session drain. Subtracts from `time_balance_seconds` (clamped at 0), appends a `session` ledger row. Idempotent per `(pc, pc_seq)`. Returns `time_balance_seconds`. |
| `debit_session_credits` | `(p_session_id uuid, p_centavos int, p_pc_seq bigint, p_synced_from text)` | **New.** Open-time drain. Subtracts whole centavos from `credits_centavos` (clamped at 0), appends an `open_time` ledger row. Same idempotency contract. Returns `credits_centavos`. |
| `purchase_time` | `(p_account_id uuid, p_centavos int, p_seconds int, p_pc_seq bigint, p_synced_from text)` | **New.** Atomically moves money into time: `credits_centavos -= p_centavos`, `time_balance_seconds += p_seconds`, one `buy_time` ledger row. Rejects with `insufficient_credits` rather than clamping. Returns both balances. |
| `sell_time` | `(p_account_id uuid, p_centavos int, p_seconds int, p_pc_seq bigint, p_synced_from text)` | Refund unused purchased time back to credits (`sell_time` ledger). Used on timed→open switch and timed logout. |
| `admin_add_credits` | `(p_admin_id uuid, p_account_id uuid, p_centavos int, p_note text, p_pc_seq bigint, p_synced_from text)` | **Changed:** takes **centavos**, not pesos, and adds to `credits_centavos` (no peso→seconds conversion server-side — the client already rounded once and must not round twice). Appends a `topup` ledger row. Returns `credits_centavos`. |
| `admin_grant_time` | `(p_admin_id uuid, p_account_id uuid, p_seconds int, p_note text, p_pc_seq bigint, p_synced_from text)` | **New, optional.** Free/courtesy time with no money movement. Appends a `grant` ledger row. Returns `time_balance_seconds`. |
| `heartbeat` | `(p_machine_id text, p_status text, p_account_id uuid)` | Unchanged. Upserts the `pcs` row; reporting `locked`/`offline` with a null account closes any open session on that PC (the logout path). |

Statuses returned in the `jsonb` `status` field:

- `login_account`: `ok` · `no_credits` · `already_in_use` · `invalid`. The
  client re-checks balances locally, so a server `no_credits` does not by itself
  block an open-time session.
- `debit_session_time` / `debit_session_credits`: `ok` · `credits_exhausted` ·
  `duplicate` · `invalid_session` · `invalid_argument`.
- `purchase_time`: `ok` · `duplicate` · `insufficient_credits` ·
  `invalid_account` · `invalid_argument`.
- `admin_add_credits` / `admin_grant_time`: `ok` · `not_admin` ·
  `invalid_account` · `invalid_argument`.
- `heartbeat`: `ok` · `invalid_argument`.

Server-side ledger rows should mirror the client's unified shape (`kind`,
`delta_centavos`, `delta_seconds`) so replayed offline rows reconcile 1:1.

---

# Windows lockdown / installer notes

True "unkillable via Task Manager" is not possible for a normal user-mode app
without a kernel driver. This is the cafe-grade approach.

## 1. Run under a limited (Standard) Windows user

Create a dedicated **Standard** user (not Administrator) for the cafe seats, e.g.
`cafeuser`. The kiosk runs as that user; admins keep a separate admin account.

## 2. Install the watchdog service (relaunches the app if killed)

Production path on a cafe build machine (needs a checkout with npm deps — the
installed app ships `resources\watchdog\watchdog-runner.js`, but `node-windows`
install still runs from the repo):

```powershell
npm run package:win
# Install the NSIS installer from release\ (e.g. Pixl Setup x.y.z.exe)
# Then, from an elevated PowerShell in the repo:
$env:PIXL_EXE = 'C:\Program Files\Pixl\Pixl.exe'
npm run watchdog:install
```

`watchdog:install` resolves paths as follows:

- **Exe:** `PIXL_EXE` if set, else `C:\Program Files\Pixl\Pixl.exe` if present
- **Script source:** `PIXL_WATCHDOG_SCRIPT` if set, else the packaged
  `C:\Program Files\Pixl\resources\watchdog\watchdog-runner.js` if present,
  else the repo-relative `watchdog\watchdog-runner.js`
- **Installed copy:** the runner + WinSW daemon live under
  `%ProgramData%\Pixl\watchdog\` so an NSIS reinstall of Pixl does not break
  the service. The Windows service name is `pixlwatchdog.exe` (display name
  `PixlWatchdog`), start type Automatic.

Keep this repo (or at least `node_modules\node-windows`) on the machine — the
service wrapper still loads from there. Remove with `npm run watchdog:uninstall`.

## 3. Pixl before desktop (recommended shell replacement)

Login-item startup cannot beat Explorer. For cafe seats, make **Pixl the
per-user Windows shell** so Winlogon starts `Pixl.exe` instead of the desktop.

1. Install Pixl and the watchdog (steps above).
2. Log in as the cafe Standard user (or load that user’s `NTUSER.DAT` offline —
   see the script header).
3. Run:

```powershell
# From the repo, as the cafe user (HKCU — elevation not required):
.\scripts\set-cafe-shell.ps1

# Restore normal desktop later:
.\scripts\set-cafe-shell.ps1 -Restore
```

Default path is `C:\Program Files\Pixl\Pixl.exe` (`-PixlPath` to override).
Packaged Pixl also writes this Shell value for the current user on startup as a
safety net; the script is the operator-facing setup path.

Keep a separate **Windows admin** account with a normal Explorer shell for
machine maintenance. Cafe user → Pixl shell; admin account → desktop.

## 4. Startup registration (fallback)

- The app also registers a login item via `app.setLoginItemSettings` (packaged
  only) if the shell value was cleared.
- The watchdog service is `Automatic` start, so the kiosk comes back even if the
  process is killed.

## 5. Disable escape hatches via GPO / registry (for the limited user)

Apply these to the **limited cafe user** only. Use `gpedit.msc` where available,
otherwise the registry keys below (log in as that user or load their hive).

- **Disable Task Manager**
  - GPO: `User Configuration → Administrative Templates → System → Ctrl+Alt+Del Options → Remove Task Manager` = Enabled
  - Registry: `HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\System` → `DisableTaskMgr` = `1` (DWORD)
- **Disable the Ctrl+Alt+Del menu items** (Lock, Switch User, Sign out, Change password) similarly under the same GPO node.
- **Disable Registry Editor**
  - `HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\System` → `DisableRegistryTools` = `1`
- **Remove the "Sign out" / shutdown escape** and hide fast user switching as needed.

> Ctrl+Alt+Del (the Secure Attention Sequence) cannot be intercepted from user
> mode by design. The GPO steps above remove its useful menu items; a kernel
> driver would be required to block the sequence itself, which is out of scope.

## 6. In-app hardening (already implemented)

- Borderless, always-on-top lockscreen covering **every** monitor; re-covers new
  monitors on `display-added`; re-asserts always-on-top on focus loss.
- Close / Alt+F4 are ignored while locked; `window-all-closed` never quits unless
  an admin used the maintenance quit path (`allowQuit`).
- A low-level keyboard hook (`node-global-key-listener`) swallows the **Win key,
  Alt+Tab, Ctrl+Esc, and Ctrl+Shift+Esc** while the lockscreen is up.
  - **Antivirus note:** the hook uses a small helper binary
    (`node_modules/.../bin/WinKeyServer.exe`) that Windows Defender / third-party
    AV frequently **quarantine as a false-positive keylogger**. If key
    suppression isn't working, add an AV exclusion for that executable (and for
    the installed app folder). The app detects a missing/blocked helper and keeps
    running in a degraded mode (logs `native key server unavailable`) rather than
    crashing — combine with the GPO steps above for defense in depth.
- Monotonic-clock session timer, so changing the Windows clock cannot add/freeze
  time. Ledger rows carry a per-PC monotonic sequence number so clock tampering
  cannot reorder or erase debits.

## 7. Admin maintenance quit

Open the Admin Panel (admin credentials — not a play session). The panel has a
**Quit (maintenance)** button that sets `allowQuit`, writes
`%PUBLIC%\Pixl\maintenance.stop` (tied to the current boot), best-effort
`sc stop PixlWatchdog`, launches **Explorer** so the machine stays usable for
maintenance on that cafe session, and exits.

While that flag matches the current boot, the watchdog **pauses relaunch** so
the app can stay closed for maintenance. Protection resumes when Pixl is
launched again (flag cleared on startup) or after a PC restart (stale flag).
**End Task** / killing the process without using Quit (maintenance) still
triggers a relaunch — the service keeps running.

A reboot or the next cafe-user login returns to the **Pixl shell** (Explorer was
only started for that maintenance session; the Winlogon `Shell` value is
unchanged).

## 8. Deep Freeze / similar disk protection

If you use Deep Freeze (or similar), **freeze only after** Pixl is installed, the
watchdog service is installed, and the cafe user’s shell is set
(`scripts\set-cafe-shell.ps1`). Thaw to change shell, watchdog, or app updates;
freeze again when configuration is stable.

## First admin account

Seed the first admin either via the Supabase SQL bootstrap (see the schema task)
or, offline, create one in the Admin Panel once you have any admin credentials.
For a brand-new offline install with no accounts, seed one directly in the local
SQLite cache or add a bootstrap admin through the schema SQL before first run.
