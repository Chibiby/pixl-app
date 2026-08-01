-- ============================================================================
-- Pixl Pisonet App — Supabase schema (money model)
--
-- Run order in the Supabase SQL editor:
--   1. schema.sql     (this file: extensions, tables, indexes, RLS)
--   2. functions.sql  (SECURITY DEFINER RPC functions)
--   3. seed.sql       (settings + bootstrap accounts)
--
-- Balance model (mirrors the client's SQLite cache):
--   accounts.credits_centavos     money on the account, integer centavos
--   accounts.time_balance_seconds purchased play time, integer seconds
-- Money is never stored as a float. The peso rate (seconds per ₱1) lives in
-- settings.peso_rate_seconds; every movement of money or time is one row in
-- the unified credit_ledger (kind + delta_centavos + delta_seconds).
--
-- Security model: clients hold only the anon key. RLS is enabled on every
-- table and NO policies are defined for anon/authenticated, so direct table
-- reads/writes are denied. All client interaction goes through the
-- SECURITY DEFINER RPCs in functions.sql. Only the service role may touch
-- tables directly.
-- ============================================================================

-- pgcrypto provides crypt() / gen_salt('bf') for bcrypt password hashing.
-- Supabase installs extensions into the "extensions" schema.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ----------------------------------------------------------------------------
-- accounts
-- ----------------------------------------------------------------------------
create table if not exists public.accounts (
  id                   uuid primary key default gen_random_uuid(),
  username             text not null unique,
  password_hash        text not null, -- bcrypt hash via extensions.crypt(pw, gen_salt('bf'))
  role                 text not null default 'client'
                         check (role in ('client', 'admin')),
  credits_centavos     integer not null default 0
                         check (credits_centavos >= 0),
  time_balance_seconds integer not null default 0
                         check (time_balance_seconds >= 0),
  display_name         text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_accounts_updated_at on public.accounts;
create trigger trg_accounts_updated_at
  before update on public.accounts
  for each row
  execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- pcs — one row per client machine, keyed by a stable Windows machine GUID
-- ----------------------------------------------------------------------------
create table if not exists public.pcs (
  id                 uuid primary key default gen_random_uuid(),
  machine_id         text not null unique,
  name               text,
  last_seen_at       timestamptz,
  current_account_id uuid references public.accounts (id) on delete set null,
  status             text not null default 'locked'
                       check (status in ('locked', 'in_session', 'offline'))
);

create index if not exists idx_pcs_current_account_id
  on public.pcs (current_account_id);

-- ----------------------------------------------------------------------------
-- sessions
--   mode: 'timed' counts down time_balance_seconds; 'open' burns
--   credits_centavos. The client does not send the mode at login, so rows
--   start 'timed' and debit_session_credits flips them to 'open' on the first
--   money debit (keeps reports accurate either way).
-- ----------------------------------------------------------------------------
create table if not exists public.sessions (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.accounts (id) on delete cascade,
  pc_id         uuid not null references public.pcs (id) on delete cascade,
  mode          text not null default 'timed'
                  check (mode in ('timed', 'open')),
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  seconds_used  integer not null default 0
                  check (seconds_used >= 0),
  centavos_used integer not null default 0
                  check (centavos_used >= 0),
  ended_reason  text
                  check (ended_reason in
                    ('logout', 'time_exhausted', 'credits_exhausted', 'shutdown', 'admin'))
);

create index if not exists idx_sessions_account_id on public.sessions (account_id);
create index if not exists idx_sessions_pc_id      on public.sessions (pc_id);
-- fast lookup of the open session on a PC
create index if not exists idx_sessions_open
  on public.sessions (pc_id)
  where ended_at is null;

-- ----------------------------------------------------------------------------
-- credit_ledger — append-only audit trail of every money/time movement,
-- one row per movement (mirrors the client's unified ledger):
--   'topup'     admin adds money            (+centavos)
--   'buy_time'  money converted to time     (-centavos, +seconds)
--   'sell_time' unused time refunded        (+centavos, -seconds)
--   'open_time' open-time play burns money  (-centavos)
--   'session'   timed play burns time       (-seconds)
--   'grant'     admin grants courtesy time  (+seconds)
--   'adjust'    manual/service-role correction
--
-- Idempotency: (pc_id, pc_seq) carries the client's monotonic per-PC sequence
-- number so offline session debits replay exactly once; the unique constraint
-- rejects duplicates. Account-level ops (purchase_time, admin top-ups/grants)
-- have no pc_id, so they are deduplicated by (account_id, kind, pc_seq) via
-- the partial unique index below.
-- ----------------------------------------------------------------------------
create table if not exists public.credit_ledger (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references public.accounts (id) on delete cascade,
  admin_id       uuid references public.accounts (id) on delete set null,
  pc_id          uuid references public.pcs (id) on delete set null,
  session_id     uuid references public.sessions (id) on delete set null,
  kind           text not null default 'adjust'
                   check (kind in ('topup', 'buy_time', 'sell_time', 'open_time', 'session', 'grant', 'adjust')),
  delta_centavos integer not null default 0,
  delta_seconds  integer not null default 0,
  note           text,
  pc_seq         bigint, -- client's monotonic per-PC sequence number
  synced_from    text not null default 'server'
                   check (synced_from in ('server', 'offline_queue')),
  created_at     timestamptz not null default now(),
  unique (pc_id, pc_seq)
);

-- Widen the kind check on existing deployments (create-table-if-not-exists
-- leaves an older CHECK untouched).
alter table public.credit_ledger drop constraint if exists credit_ledger_kind_check;
alter table public.credit_ledger add constraint credit_ledger_kind_check
  check (kind in ('topup', 'buy_time', 'sell_time', 'open_time', 'session', 'grant', 'adjust'));

-- Dedupe key for account-level replays (pc_id is null there, which the plain
-- unique constraint treats as distinct). Scoped by kind so a purchase and a
-- top-up from different machines that happen to share a seq value cannot
-- shadow each other across kinds.
create unique index if not exists idx_credit_ledger_account_op
  on public.credit_ledger (account_id, kind, pc_seq)
  where pc_id is null and pc_seq is not null;

create index if not exists idx_credit_ledger_account_id on public.credit_ledger (account_id);
create index if not exists idx_credit_ledger_admin_id   on public.credit_ledger (admin_id);
create index if not exists idx_credit_ledger_pc_id      on public.credit_ledger (pc_id);
create index if not exists idx_credit_ledger_session_id on public.credit_ledger (session_id);
create index if not exists idx_credit_ledger_created_at on public.credit_ledger (created_at);

-- ----------------------------------------------------------------------------
-- settings — key/value app configuration (see seed.sql for defaults)
-- ----------------------------------------------------------------------------
create table if not exists public.settings (
  key   text primary key,
  value text not null
);

-- ----------------------------------------------------------------------------
-- sync_queue — INTENTIONALLY NOT CREATED HERE.
-- The sync_queue table (pending offline writes with retry until Supabase ACK)
-- lives only in each PC's local SQLite cache. It never exists in Postgres.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- Row Level Security
--
-- RLS is enabled on every table and no policies are created for anon or
-- authenticated. With RLS on and zero policies, every direct SELECT / INSERT /
-- UPDATE / DELETE from client roles is denied. Clients must go through the
-- SECURITY DEFINER RPCs (functions.sql), which run as the table owner and
-- therefore bypass RLS internally.
-- ============================================================================
alter table public.accounts      enable row level security;
alter table public.pcs           enable row level security;
alter table public.sessions      enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.settings      enable row level security;

-- Belt and suspenders: strip the table privileges Supabase grants to client
-- roles by default, and grant tables only to the service role.
revoke all on table
  public.accounts,
  public.pcs,
  public.sessions,
  public.credit_ledger,
  public.settings
from anon, authenticated;

grant select, insert, update, delete on table
  public.accounts,
  public.pcs,
  public.sessions,
  public.credit_ledger,
  public.settings
to service_role;
