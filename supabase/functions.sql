-- ============================================================================
-- Pixl Pisonet App — RPC functions (money model)
--
-- Run AFTER schema.sql. All functions are SECURITY DEFINER: they execute as
-- the table owner (bypassing RLS internally) and are the ONLY way the anon
-- key can read or mutate data. Call them from the client via
-- supabase.rpc('<name>', {...}).
--
-- Function surface (matches electron/sync/supabase.ts):
--   login_account(p_username text, p_password text, p_machine_id text)
--   upsert_account(p_id uuid, p_username text, p_password_hash text,
--                  p_role text, p_display_name text, p_credits_centavos int,
--                  p_time_balance_seconds int)
--   debit_session_time(p_session_id uuid, p_seconds int, p_pc_seq bigint
--                      [, p_synced_from text = 'server'])
--   debit_session_credits(p_session_id uuid, p_centavos int, p_pc_seq bigint
--                         [, p_synced_from text = 'server'])
--   purchase_time(p_account_id uuid, p_centavos int, p_seconds int,
--                 p_pc_seq bigint [, p_synced_from text = 'server'])
--   sell_time(p_account_id uuid, p_centavos int, p_seconds int,
--             p_pc_seq bigint [, p_synced_from text = 'server'])
--   admin_add_credits(p_admin_id uuid, p_account_id uuid, p_centavos int
--                     [, p_note text, p_pc_seq bigint, p_synced_from text])
--   admin_grant_time(p_admin_id uuid, p_account_id uuid, p_seconds int
--                    [, p_note text, p_pc_seq bigint, p_synced_from text])
--   heartbeat(p_machine_id text, p_status text, p_account_id uuid = null)
-- ============================================================================

-- Upgrading from the pre-money-model deployment? Drop the old signatures so
-- PostgREST does not see ambiguous overloads. No-ops on a fresh project.
drop function if exists public.admin_add_credits(uuid, uuid, numeric, text, text);

-- ----------------------------------------------------------------------------
-- Internal helper: bcrypt check tolerant of the $2b$ prefix.
-- bcryptjs (the client) emits $2b$ hashes; pgcrypto's crypt() verifies them,
-- but older pgcrypto builds only recognise $2a$. For bcryptjs-generated hashes
-- the two prefixes verify identically, so normalise before comparing.
-- ----------------------------------------------------------------------------
create or replace function public.check_password(p_password text, p_hash text)
returns boolean
language sql
security definer
set search_path = public, extensions
as $$
  select p_hash is not null
     and regexp_replace(p_hash, '^\$2b\$', '$2a$')
         = crypt(p_password, regexp_replace(p_hash, '^\$2b\$', '$2a$'));
$$;

-- ----------------------------------------------------------------------------
-- login_account
--
-- Verifies bcrypt credentials, enforces the single-session rule, checks that
-- the account can pay for a session at all, opens a session, and marks the
-- PC in_session.
--
-- Returns jsonb with a "status" the client maps to the lockscreen rules:
--   'invalid'        -> bad username or password
--   'already_in_use' -> account has an active session on another PC
--   'no_credits'     -> valid client account but BOTH balances are zero
--                       (the client re-checks balances locally, so this alone
--                       never blocks a session the local cache can cover)
--   'ok'             -> session started (or admin unlocked into admin panel)
--
-- On 'ok' / 'no_credits' the payload includes the account with BOTH balances
-- (credits_centavos + time_balance_seconds) and its bcrypt password_hash so
-- the client can cache it for offline login verification. Admin logins return
-- 'ok' with a null session_id: admins unlock into the admin panel, not a play
-- session.
-- ----------------------------------------------------------------------------
create or replace function public.login_account(
  p_username   text,
  p_password   text,
  p_machine_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_account public.accounts%rowtype;
  v_pc      public.pcs%rowtype;
  v_session public.sessions%rowtype;
  v_payload jsonb;
begin
  if p_username is null or p_password is null or p_machine_id is null then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- Lock the account row to serialize concurrent logins for the same account.
  -- Match case-insensitively so legacy rows and upsert_account's lower() store
  -- both resolve the same way.
  select * into v_account
  from public.accounts
  where lower(username) = lower(trim(p_username))
  for update;

  if not found or not public.check_password(p_password, v_account.password_hash) then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- Ensure this PC is registered and refresh its last_seen_at.
  insert into public.pcs (machine_id, name, status, last_seen_at)
  values (p_machine_id, p_machine_id, 'locked', now())
  on conflict (machine_id) do update
    set last_seen_at = now()
  returning * into v_pc;

  v_payload := jsonb_build_object(
    'id',                   v_account.id,
    'display_name',         v_account.display_name,
    'role',                 v_account.role,
    'credits_centavos',     v_account.credits_centavos,
    'time_balance_seconds', v_account.time_balance_seconds,
    'password_hash',        v_account.password_hash
  );

  if v_account.role = 'admin' then
    return jsonb_build_object(
      'status',     'ok',
      'account',    v_payload,
      'session_id', null,
      'pc_id',      v_pc.id
    );
  end if;

  -- Single-session rule: reject if the account is active on a different PC.
  if exists (
       select 1 from public.pcs
       where current_account_id = v_account.id
         and status = 'in_session'
         and machine_id <> p_machine_id
     )
     or exists (
       select 1 from public.sessions
       where account_id = v_account.id
         and ended_at is null
         and pc_id <> v_pc.id
     ) then
    return jsonb_build_object('status', 'already_in_use');
  end if;

  -- A session is startable if EITHER balance can pay for it: purchased time
  -- covers a timed session, money covers open time (or buying time up front).
  if v_account.credits_centavos <= 0 and v_account.time_balance_seconds <= 0 then
    return jsonb_build_object(
      'status',  'no_credits',
      'account', v_payload
    );
  end if;

  -- Crash recovery: close any session left open on this same PC.
  update public.sessions
  set ended_at = now(), ended_reason = 'shutdown'
  where pc_id = v_pc.id and ended_at is null;

  insert into public.sessions (account_id, pc_id)
  values (v_account.id, v_pc.id)
  returning * into v_session;

  update public.pcs
  set status             = 'in_session',
      current_account_id = v_account.id,
      last_seen_at       = now()
  where id = v_pc.id;

  return jsonb_build_object(
    'status',     'ok',
    'account',    v_payload,
    'session_id', v_session.id,
    'pc_id',      v_pc.id
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- upsert_account
--
-- Inserts or updates an account keyed by case-normalized username
-- (lower(trim(...))). Used to push offline/admin-created accounts (and local
-- credential/balance edits) up to the server so a later login_account can
-- succeed online.
--
-- On insert the client-supplied p_id is preserved. On username conflict the
-- existing row keeps its id; password_hash, role, display_name, and both
-- balances are overwritten from the payload.
--
-- Returns jsonb "status":
--   'ok'               -> payload includes the account row
--   'invalid_argument' -> missing/empty fields, bad role, or negative balances
-- ----------------------------------------------------------------------------
create or replace function public.upsert_account(
  p_id                    uuid,
  p_username              text,
  p_password_hash         text,
  p_role                  text,
  p_display_name          text,
  p_credits_centavos      integer,
  p_time_balance_seconds  integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_username text;
  v_display  text;
  v_account  public.accounts%rowtype;
begin
  v_username := lower(trim(coalesce(p_username, '')));
  v_display  := coalesce(nullif(trim(p_display_name), ''), v_username);

  if p_id is null
     or v_username = ''
     or p_password_hash is null or length(trim(p_password_hash)) = 0
     or p_role is null or p_role not in ('client', 'admin')
     or p_credits_centavos is null or p_credits_centavos < 0
     or p_time_balance_seconds is null or p_time_balance_seconds < 0 then
    return jsonb_build_object('status', 'invalid_argument');
  end if;

  -- Case-insensitive match so legacy mixed-case rows collide with lower() keys.
  select * into v_account
  from public.accounts
  where lower(username) = v_username
  for update;

  if found then
    update public.accounts
    set username             = v_username,
        password_hash        = p_password_hash,
        role                 = p_role,
        display_name         = v_display,
        credits_centavos     = p_credits_centavos,
        time_balance_seconds = p_time_balance_seconds
    where id = v_account.id
    returning * into v_account;
  else
    insert into public.accounts (
      id,
      username,
      password_hash,
      role,
      credits_centavos,
      time_balance_seconds,
      display_name
    )
    values (
      p_id,
      v_username,
      p_password_hash,
      p_role,
      p_credits_centavos,
      p_time_balance_seconds,
      v_display
    )
    returning * into v_account;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'account', jsonb_build_object(
      'id',                   v_account.id,
      'username',             v_account.username,
      'display_name',         v_account.display_name,
      'role',                 v_account.role,
      'credits_centavos',     v_account.credits_centavos,
      'time_balance_seconds', v_account.time_balance_seconds,
      'password_hash',        v_account.password_hash
    )
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- debit_session_time — TIMED session drain.
--
-- Subtracts play time from the account's time_balance_seconds (clamped at 0),
-- appends a 'session' ledger row carrying the monotonic per-PC sequence
-- number (p_pc_seq), and adds p_seconds to sessions.seconds_used.
--
-- Idempotent: if a ledger row with the same (pc_id, pc_seq) already exists,
-- the debit was already applied (e.g. an offline-queue retry) and the call
-- returns 'duplicate' without double-debiting.
--
-- Returns jsonb "status":
--   'ok'                -> debited, time remains
--   'credits_exhausted' -> debited, time balance hit 0; session closed and PC
--                          reset to locked (client relocks on its own too)
--   'duplicate'         -> that (pc_id, pc_seq) was already applied
--   'invalid_session'   -> unknown session id
--   'invalid_argument'  -> p_seconds missing or <= 0, or bad p_synced_from
-- Payload carries 'time_balance_seconds' except on invalid_*.
-- ----------------------------------------------------------------------------
create or replace function public.debit_session_time(
  p_session_id  uuid,
  p_seconds     integer,
  p_pc_seq      bigint,
  p_synced_from text default 'server'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_session   public.sessions%rowtype;
  v_account   public.accounts%rowtype;
  v_debit     integer;
  v_remaining integer;
begin
  if p_seconds is null or p_seconds <= 0
     or p_synced_from not in ('server', 'offline_queue') then
    return jsonb_build_object('status', 'invalid_argument');
  end if;

  select * into v_session
  from public.sessions
  where id = p_session_id
  for update;

  if not found then
    return jsonb_build_object('status', 'invalid_session');
  end if;

  select * into v_account
  from public.accounts
  where id = v_session.account_id
  for update;

  if p_pc_seq is not null and exists (
    select 1 from public.credit_ledger
    where pc_id = v_session.pc_id and pc_seq = p_pc_seq
  ) then
    return jsonb_build_object(
      'status', 'duplicate',
      'time_balance_seconds', v_account.time_balance_seconds
    );
  end if;

  -- Clamp at zero: never debit more than the account holds.
  v_debit     := least(p_seconds, v_account.time_balance_seconds);
  v_remaining := v_account.time_balance_seconds - v_debit;

  update public.accounts
  set time_balance_seconds = v_remaining
  where id = v_account.id;

  -- seconds_used tracks real elapsed play time, even for the final
  -- partially-covered tick.
  update public.sessions
  set seconds_used = seconds_used + p_seconds
  where id = v_session.id;

  insert into public.credit_ledger
    (account_id, pc_id, session_id, kind, delta_centavos, delta_seconds,
     note, pc_seq, synced_from)
  values
    (v_account.id, v_session.pc_id, v_session.id, 'session', 0, -v_debit,
     'timed session', p_pc_seq, p_synced_from);

  if v_remaining <= 0 then
    update public.sessions
    set ended_at = now(), ended_reason = 'time_exhausted'
    where id = v_session.id and ended_at is null;

    update public.pcs
    set status = 'locked', current_account_id = null
    where id = v_session.pc_id and current_account_id = v_account.id;

    return jsonb_build_object(
      'status', 'credits_exhausted',
      'time_balance_seconds', 0
    );
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'time_balance_seconds', v_remaining
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- debit_session_credits — OPEN TIME drain.
--
-- Subtracts whole centavos from the account's credits_centavos (clamped at 0),
-- appends an 'open_time' ledger row, adds the amount to sessions.centavos_used,
-- and marks the session mode 'open' (the client does not send the mode at
-- login). Same (pc_id, pc_seq) idempotency contract as debit_session_time.
--
-- Returns jsonb "status":
--   'ok' | 'credits_exhausted' | 'duplicate' | 'invalid_session' |
--   'invalid_argument', with 'credits_centavos' on the first three.
-- ----------------------------------------------------------------------------
create or replace function public.debit_session_credits(
  p_session_id  uuid,
  p_centavos    integer,
  p_pc_seq      bigint,
  p_synced_from text default 'server'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_session   public.sessions%rowtype;
  v_account   public.accounts%rowtype;
  v_debit     integer;
  v_remaining integer;
begin
  if p_centavos is null or p_centavos <= 0
     or p_synced_from not in ('server', 'offline_queue') then
    return jsonb_build_object('status', 'invalid_argument');
  end if;

  select * into v_session
  from public.sessions
  where id = p_session_id
  for update;

  if not found then
    return jsonb_build_object('status', 'invalid_session');
  end if;

  select * into v_account
  from public.accounts
  where id = v_session.account_id
  for update;

  if p_pc_seq is not null and exists (
    select 1 from public.credit_ledger
    where pc_id = v_session.pc_id and pc_seq = p_pc_seq
  ) then
    return jsonb_build_object(
      'status', 'duplicate',
      'credits_centavos', v_account.credits_centavos
    );
  end if;

  v_debit     := least(p_centavos, v_account.credits_centavos);
  v_remaining := v_account.credits_centavos - v_debit;

  update public.accounts
  set credits_centavos = v_remaining
  where id = v_account.id;

  update public.sessions
  set mode          = 'open',
      centavos_used = centavos_used + v_debit
  where id = v_session.id;

  insert into public.credit_ledger
    (account_id, pc_id, session_id, kind, delta_centavos, delta_seconds,
     note, pc_seq, synced_from)
  values
    (v_account.id, v_session.pc_id, v_session.id, 'open_time', -v_debit, 0,
     'open time', p_pc_seq, p_synced_from);

  if v_remaining <= 0 then
    update public.sessions
    set ended_at = now(), ended_reason = 'credits_exhausted'
    where id = v_session.id and ended_at is null;

    update public.pcs
    set status = 'locked', current_account_id = null
    where id = v_session.pc_id and current_account_id = v_account.id;

    return jsonb_build_object(
      'status', 'credits_exhausted',
      'credits_centavos', 0
    );
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'credits_centavos', v_remaining
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- purchase_time
--
-- Atomically moves money into purchased time: credits_centavos -= p_centavos,
-- time_balance_seconds += p_seconds, one 'buy_time' ledger row carrying both
-- deltas. Rejects with 'insufficient_credits' rather than clamping — a
-- partial purchase would desync the client, which already checked the price.
--
-- The client computed p_seconds from its configured peso rate at purchase
-- time; the server records the pair as-is so replays reconcile 1:1 with the
-- client's local ledger row.
--
-- Idempotent per (account_id, 'buy_time', p_pc_seq) — see schema.sql.
--
-- Returns jsonb "status":
--   'ok' | 'duplicate' | 'insufficient_credits' | 'invalid_account' |
--   'invalid_argument', with both balances on ok/duplicate.
-- ----------------------------------------------------------------------------
create or replace function public.purchase_time(
  p_account_id  uuid,
  p_centavos    integer,
  p_seconds     integer,
  p_pc_seq      bigint,
  p_synced_from text default 'server'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_account public.accounts%rowtype;
begin
  if p_centavos is null or p_centavos <= 0
     or p_seconds is null or p_seconds <= 0
     or p_synced_from not in ('server', 'offline_queue') then
    return jsonb_build_object('status', 'invalid_argument');
  end if;

  select * into v_account
  from public.accounts
  where id = p_account_id
  for update;

  if not found then
    return jsonb_build_object('status', 'invalid_account');
  end if;

  if p_pc_seq is not null and exists (
    select 1 from public.credit_ledger
    where account_id = p_account_id
      and kind = 'buy_time'
      and pc_seq = p_pc_seq
      and pc_id is null
  ) then
    return jsonb_build_object(
      'status', 'duplicate',
      'credits_centavos',     v_account.credits_centavos,
      'time_balance_seconds', v_account.time_balance_seconds
    );
  end if;

  if v_account.credits_centavos < p_centavos then
    return jsonb_build_object('status', 'insufficient_credits');
  end if;

  update public.accounts
  set credits_centavos     = credits_centavos - p_centavos,
      time_balance_seconds = time_balance_seconds + p_seconds
  where id = p_account_id
  returning * into v_account;

  insert into public.credit_ledger
    (account_id, kind, delta_centavos, delta_seconds, note, pc_seq, synced_from)
  values
    (p_account_id, 'buy_time', -p_centavos, p_seconds, 'buy time',
     p_pc_seq, p_synced_from);

  return jsonb_build_object(
    'status', 'ok',
    'credits_centavos',     v_account.credits_centavos,
    'time_balance_seconds', v_account.time_balance_seconds
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- sell_time
--
-- Inverse of purchase_time: refunds unused purchased time into money.
-- credits_centavos += p_centavos, time_balance_seconds -= p_seconds (clamped
-- at zero), one 'sell_time' ledger row carrying both deltas.
--
-- The client computed p_centavos from its configured peso rate at refund
-- time; the server records the pair as-is so replays reconcile 1:1 with the
-- client's local ledger row. Seconds are clamped rather than rejected so a
-- stale offline refund cannot fail after timed play already burned some of
-- the balance.
--
-- Idempotent per (account_id, 'sell_time', p_pc_seq) — see schema.sql.
--
-- Returns jsonb "status":
--   'ok' | 'duplicate' | 'invalid_account' | 'invalid_argument',
--   with both balances on ok/duplicate.
-- ----------------------------------------------------------------------------
create or replace function public.sell_time(
  p_account_id  uuid,
  p_centavos    integer,
  p_seconds     integer,
  p_pc_seq      bigint,
  p_synced_from text default 'server'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_account public.accounts%rowtype;
  v_seconds integer;
begin
  if p_centavos is null or p_centavos < 0
     or p_seconds is null or p_seconds <= 0
     or p_synced_from not in ('server', 'offline_queue') then
    return jsonb_build_object('status', 'invalid_argument');
  end if;

  select * into v_account
  from public.accounts
  where id = p_account_id
  for update;

  if not found then
    return jsonb_build_object('status', 'invalid_account');
  end if;

  if p_pc_seq is not null and exists (
    select 1 from public.credit_ledger
    where account_id = p_account_id
      and kind = 'sell_time'
      and pc_seq = p_pc_seq
      and pc_id is null
  ) then
    return jsonb_build_object(
      'status', 'duplicate',
      'credits_centavos',     v_account.credits_centavos,
      'time_balance_seconds', v_account.time_balance_seconds
    );
  end if;

  v_seconds := least(p_seconds, greatest(0, v_account.time_balance_seconds));

  -- Already sold (e.g. upsert pushed post-refund balances): do not add credits
  -- again when there are no seconds left to convert.
  if v_seconds <= 0 then
    return jsonb_build_object(
      'status', 'ok',
      'credits_centavos',     v_account.credits_centavos,
      'time_balance_seconds', v_account.time_balance_seconds
    );
  end if;

  -- Scale money to the seconds actually removed when the balance was partially
  -- drained since the client computed p_centavos.
  p_centavos := case
    when v_seconds = p_seconds then p_centavos
    else (p_centavos::bigint * v_seconds / p_seconds)::integer
  end;

  update public.accounts
  set credits_centavos     = credits_centavos + p_centavos,
      time_balance_seconds = time_balance_seconds - v_seconds
  where id = p_account_id
  returning * into v_account;

  insert into public.credit_ledger
    (account_id, kind, delta_centavos, delta_seconds, note, pc_seq, synced_from)
  values
    (p_account_id, 'sell_time', p_centavos, -v_seconds, 'sell time',
     p_pc_seq, p_synced_from);

  return jsonb_build_object(
    'status', 'ok',
    'credits_centavos',     v_account.credits_centavos,
    'time_balance_seconds', v_account.time_balance_seconds
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- admin_add_credits
--
-- Verifies the caller account is an admin and adds MONEY (centavos) to the
-- target account's credits_centavos, appending a 'topup' ledger row. Takes
-- centavos, not pesos: the client already rounded the typed peso amount once
-- and must not round twice. No peso→seconds conversion happens server-side —
-- converting money into play time is the customer's decision (purchase_time).
--
-- Idempotent per (account_id, 'topup', p_pc_seq).
--
-- Returns jsonb "status":
--   'ok' | 'not_admin' | 'invalid_account' | 'invalid_argument',
--   with 'credits_centavos' on ok.
-- ----------------------------------------------------------------------------
create or replace function public.admin_add_credits(
  p_admin_id    uuid,
  p_account_id  uuid,
  p_centavos    integer,
  p_note        text default null,
  p_pc_seq      bigint default null,
  p_synced_from text default 'server'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_admin_role  text;
  v_new_balance integer;
begin
  if p_centavos is null or p_centavos <= 0
     or p_synced_from not in ('server', 'offline_queue') then
    return jsonb_build_object('status', 'invalid_argument');
  end if;

  select role into v_admin_role
  from public.accounts
  where id = p_admin_id;

  if v_admin_role is distinct from 'admin' then
    return jsonb_build_object('status', 'not_admin');
  end if;

  if p_pc_seq is not null and exists (
    select 1 from public.credit_ledger
    where account_id = p_account_id
      and kind = 'topup'
      and pc_seq = p_pc_seq
      and pc_id is null
  ) then
    select credits_centavos into v_new_balance
    from public.accounts where id = p_account_id;
    return jsonb_build_object(
      'status', 'ok', -- replay of an applied top-up: report success
      'credits_centavos', coalesce(v_new_balance, 0)
    );
  end if;

  update public.accounts
  set credits_centavos = credits_centavos + p_centavos
  where id = p_account_id
  returning credits_centavos into v_new_balance;

  if not found then
    return jsonb_build_object('status', 'invalid_account');
  end if;

  insert into public.credit_ledger
    (account_id, admin_id, kind, delta_centavos, delta_seconds, note, pc_seq, synced_from)
  values
    (p_account_id, p_admin_id, 'topup', p_centavos, 0,
     coalesce(p_note, 'admin top-up'), p_pc_seq, p_synced_from);

  return jsonb_build_object(
    'status', 'ok',
    'credits_centavos', v_new_balance
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- admin_grant_time
--
-- Courtesy/free play time with no money movement: adds seconds to the target
-- account's time_balance_seconds and appends a 'grant' ledger row.
--
-- Idempotent per (account_id, 'grant', p_pc_seq).
--
-- Returns jsonb "status":
--   'ok' | 'not_admin' | 'invalid_account' | 'invalid_argument',
--   with 'time_balance_seconds' on ok.
-- ----------------------------------------------------------------------------
create or replace function public.admin_grant_time(
  p_admin_id    uuid,
  p_account_id  uuid,
  p_seconds     integer,
  p_note        text default null,
  p_pc_seq      bigint default null,
  p_synced_from text default 'server'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_admin_role  text;
  v_new_balance integer;
begin
  if p_seconds is null or p_seconds <= 0
     or p_synced_from not in ('server', 'offline_queue') then
    return jsonb_build_object('status', 'invalid_argument');
  end if;

  select role into v_admin_role
  from public.accounts
  where id = p_admin_id;

  if v_admin_role is distinct from 'admin' then
    return jsonb_build_object('status', 'not_admin');
  end if;

  if p_pc_seq is not null and exists (
    select 1 from public.credit_ledger
    where account_id = p_account_id
      and kind = 'grant'
      and pc_seq = p_pc_seq
      and pc_id is null
  ) then
    select time_balance_seconds into v_new_balance
    from public.accounts where id = p_account_id;
    return jsonb_build_object(
      'status', 'ok', -- replay of an applied grant: report success
      'time_balance_seconds', coalesce(v_new_balance, 0)
    );
  end if;

  update public.accounts
  set time_balance_seconds = time_balance_seconds + p_seconds
  where id = p_account_id
  returning time_balance_seconds into v_new_balance;

  if not found then
    return jsonb_build_object('status', 'invalid_account');
  end if;

  insert into public.credit_ledger
    (account_id, admin_id, kind, delta_centavos, delta_seconds, note, pc_seq, synced_from)
  values
    (p_account_id, p_admin_id, 'grant', 0, p_seconds,
     coalesce(p_note, 'time grant'), p_pc_seq, p_synced_from);

  return jsonb_build_object(
    'status', 'ok',
    'time_balance_seconds', v_new_balance
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- heartbeat
--
-- Upserts the pcs row for this machine and refreshes last_seen_at. Also the
-- normal way a client ends a session server-side: reporting status 'locked'
-- (or 'offline') with a null account closes any open session on that PC
-- (ended_reason 'logout' for locked, 'shutdown' for offline).
--
-- Returns jsonb "status":
--   'ok'               -> payload has 'pc_id'
--   'invalid_argument' -> p_machine_id null or p_status not one of
--                         locked | in_session | offline
-- ----------------------------------------------------------------------------
create or replace function public.heartbeat(
  p_machine_id text,
  p_status     text,
  p_account_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_pc public.pcs%rowtype;
begin
  if p_machine_id is null
     or p_status not in ('locked', 'in_session', 'offline') then
    return jsonb_build_object('status', 'invalid_argument');
  end if;

  insert into public.pcs (machine_id, name, status, current_account_id, last_seen_at)
  values (p_machine_id, p_machine_id, p_status, p_account_id, now())
  on conflict (machine_id) do update
    set status             = excluded.status,
        current_account_id = excluded.current_account_id,
        last_seen_at       = now()
  returning * into v_pc;

  if p_status <> 'in_session' and p_account_id is null then
    update public.sessions
    set ended_at     = now(),
        ended_reason = case when p_status = 'offline' then 'shutdown' else 'logout' end
    where pc_id = v_pc.id and ended_at is null;
  end if;

  return jsonb_build_object('status', 'ok', 'pc_id', v_pc.id);
end;
$$;

-- ============================================================================
-- Grants: expose the RPCs (and nothing else) to client roles.
-- check_password stays internal — no client-facing grant.
-- ============================================================================
revoke all on function public.check_password(text, text) from public, anon, authenticated;
revoke all on function public.login_account(text, text, text) from public;
revoke all on function public.upsert_account(uuid, text, text, text, text, integer, integer) from public;
revoke all on function public.debit_session_time(uuid, integer, bigint, text) from public;
revoke all on function public.debit_session_credits(uuid, integer, bigint, text) from public;
revoke all on function public.purchase_time(uuid, integer, integer, bigint, text) from public;
revoke all on function public.sell_time(uuid, integer, integer, bigint, text) from public;
revoke all on function public.admin_add_credits(uuid, uuid, integer, text, bigint, text) from public;
revoke all on function public.admin_grant_time(uuid, uuid, integer, text, bigint, text) from public;
revoke all on function public.heartbeat(text, text, uuid) from public;

grant execute on function public.login_account(text, text, text)
  to anon, authenticated, service_role;
grant execute on function public.upsert_account(uuid, text, text, text, text, integer, integer)
  to anon, authenticated, service_role;
grant execute on function public.debit_session_time(uuid, integer, bigint, text)
  to anon, authenticated, service_role;
grant execute on function public.debit_session_credits(uuid, integer, bigint, text)
  to anon, authenticated, service_role;
grant execute on function public.purchase_time(uuid, integer, integer, bigint, text)
  to anon, authenticated, service_role;
grant execute on function public.sell_time(uuid, integer, integer, bigint, text)
  to anon, authenticated, service_role;
grant execute on function public.admin_add_credits(uuid, uuid, integer, text, bigint, text)
  to anon, authenticated, service_role;
grant execute on function public.admin_grant_time(uuid, uuid, integer, text, bigint, text)
  to anon, authenticated, service_role;
grant execute on function public.heartbeat(text, text, uuid)
  to anon, authenticated, service_role;
