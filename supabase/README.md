# Pixl Pisonet App — Supabase backend

Postgres schema, RPC functions, and seed data for the Pixl Pisonet client,
implementing the **money model**: every account carries `credits_centavos`
(money, integer centavos) and `time_balance_seconds` (purchased play time).
Supabase is the source of truth when online; each client PC keeps a local
SQLite cache (including the SQLite-only `sync_queue` table) and reconciles
with these tables when connectivity returns.

## Setup from scratch

1. Create a new project at [supabase.com](https://supabase.com) (any region,
   pick a strong database password).
2. Open **SQL Editor** in the project dashboard and run the files in order,
   each as one query:
   1. `schema.sql` — extensions, tables, indexes, triggers, RLS
   2. `functions.sql` — the SECURITY DEFINER RPC functions
   3. `seed.sql` — default settings + bootstrap accounts
3. **Change the bootstrap admin password.** `seed.sql` creates `admin` /
   `admin`; the comment in that file shows the one-line SQL to rehash it.
4. Grab the client credentials from **Project Settings → API**:
   - **Project URL** → `SUPABASE_URL`
   - **anon public key** → `SUPABASE_ANON_KEY`

   Put them in the client app's `.env` (see `.env.example` here). Never commit
   real keys. The **service_role** key is not used by client PCs — keep it
   secret; it is only for server-side maintenance.
5. **Flip the client flag.** In `electron/sync/supabase.ts` set
   `MONEY_RPCS_DEPLOYED = true`. Until then the client keeps money movements
   local-only (it is fully correct offline-first either way); with the flag on,
   open-time debits, time purchases, and admin top-ups/grants replay to these
   RPCs.

## Security model

- Row Level Security is enabled on every table with **no policies** for
  `anon`/`authenticated`, and table privileges are revoked from those roles.
  The anon key cannot SELECT, INSERT, UPDATE, or DELETE any table directly.
- Clients interact **only** through the SECURITY DEFINER RPC functions below
  (`supabase.rpc('name', {...})`). Direct table access is reserved for the
  service role.
- Passwords are bcrypt hashes, verified server-side inside `login_account`.
  The client (bcryptjs) emits `$2b$` hashes; `check_password` normalises the
  prefix so pgcrypto's `crypt()` verifies them on any Postgres version.

## RPC surface

Matches the client wrappers in `electron/sync/supabase.ts` 1:1.

| Function | Signature | Purpose |
| --- | --- | --- |
| `login_account` | `(p_username text, p_password text, p_machine_id text)` | Verify credentials, enforce single-session rule, open a session, mark the PC `in_session`. `no_credits` only when **both** balances are zero. |
| `upsert_account` | `(p_id uuid, p_username text, p_password_hash text, p_role text, p_display_name text, p_credits_centavos int, p_time_balance_seconds int)` | Insert or update by case-normalized username. Preserves `p_id` on insert; on conflict updates hash/role/display/balances. Used to sync offline/admin-created accounts. |
| `debit_session_time` | `(p_session_id uuid, p_seconds int, p_pc_seq bigint [, p_synced_from])` | Timed-session drain: subtract purchased time (clamped at 0), append a `session` ledger row, bump `sessions.seconds_used`. Idempotent per `(pc, pc_seq)`. |
| `debit_session_credits` | `(p_session_id uuid, p_centavos int, p_pc_seq bigint [, p_synced_from])` | Open-time drain: subtract whole centavos (clamped at 0), append an `open_time` ledger row, bump `sessions.centavos_used`, flag the session `mode = 'open'`. Same idempotency. |
| `purchase_time` | `(p_account_id uuid, p_centavos int, p_seconds int, p_pc_seq bigint [, p_synced_from])` | Atomically move money into time, one `buy_time` ledger row carrying both deltas. Rejects with `insufficient_credits` rather than clamping. |
| `sell_time` | `(p_account_id uuid, p_centavos int, p_seconds int, p_pc_seq bigint [, p_synced_from])` | Inverse of purchase: refund unused purchased time to credits (`sell_time` ledger). Idempotent per `(account_id, kind, pc_seq)`. |
| `admin_add_credits` | `(p_admin_id uuid, p_account_id uuid, p_centavos int [, p_note, p_pc_seq, p_synced_from])` | Verify admin role, add **centavos** to the money balance (no peso→seconds conversion server-side), append a `topup` ledger row. |
| `admin_grant_time` | `(p_admin_id uuid, p_account_id uuid, p_seconds int [, p_note, p_pc_seq, p_synced_from])` | Courtesy time with no money movement, `grant` ledger row. |
| `heartbeat` | `(p_machine_id text, p_status text, p_account_id uuid = null)` | Upsert the `pcs` row, refresh `last_seen_at`. Reporting `locked`/`offline` with a null account closes any open session on that PC (the logout path). |

All functions return `jsonb` with a `status` field:

- `login_account`: `ok` (payload: `account {id, display_name, role,
  credits_centavos, time_balance_seconds, password_hash}`, `session_id`,
  `pc_id`) · `no_credits` · `already_in_use` · `invalid`. Admin logins return
  `ok` with a null `session_id` (admin panel, not a play session). The
  `password_hash` in the payload is for the client's offline-login cache. The
  client re-checks balances locally, so a server `no_credits` never blocks a
  session the local cache can cover.
- `upsert_account`: `ok` (payload: `account {id, username, display_name, role,
  credits_centavos, time_balance_seconds, password_hash}`) · `invalid_argument`.
- `debit_session_time` / `debit_session_credits`: `ok` ·
  `credits_exhausted` (balance hit 0; session closed, PC reset to locked) ·
  `duplicate` (that `pc_seq` was already applied) · `invalid_session` ·
  `invalid_argument`.
- `purchase_time`: `ok` · `duplicate` · `insufficient_credits` ·
  `invalid_account` · `invalid_argument`.
- `admin_add_credits` / `admin_grant_time`: `ok` (replays of an
  already-applied op also return `ok`) · `not_admin` · `invalid_account` ·
  `invalid_argument`.
- `heartbeat`: `ok` (payload: `pc_id`) · `invalid_argument`.

## Ledger

`credit_ledger` is append-only and mirrors the client's unified shape so
replayed offline rows reconcile 1:1:

| kind | delta_centavos | delta_seconds | Meaning |
| --- | --- | --- | --- |
| `topup` | + | 0 | admin adds money |
| `buy_time` | − | + | money converted to time |
| `open_time` | − | 0 | open-time play burns money |
| `session` | 0 | − | timed play burns time |
| `grant` | 0 | + | admin grants courtesy time |
| `adjust` | any | any | manual/service-role correction |

## Idempotency & offline replay

- Queued offline writes are replayed through the same RPCs with
  `p_synced_from = 'offline_queue'`.
- Session debits carry the client's monotonic per-PC sequence number; the
  unique `(pc_id, pc_seq)` constraint makes replays exact-once.
- Account-level ops (`purchase_time`, `admin_add_credits`,
  `admin_grant_time`) have no PC reference in their payload, so they are
  deduplicated by `(account_id, kind, pc_seq)` instead. Caveat: two different
  PCs replaying the *same kind* of op for the *same account* with a colliding
  seq value would be treated as duplicates — vanishingly rare in practice, and
  the client's local ledger remains the durable record.

## Notes

- `seed.sql` is idempotent (`on conflict do nothing`); re-running it never
  overwrites tuned settings or changed passwords.
- Upgrading a pre-money-model project: `functions.sql` drops the old
  peso-based `admin_add_credits` overload, but `schema.sql` assumes a fresh
  database — migrate existing `time_credits_seconds` data manually
  (`update accounts set time_balance_seconds = time_credits_seconds`) before
  dropping the old column.
