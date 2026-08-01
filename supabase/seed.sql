-- ============================================================================
-- Pixl Pisonet App — seed data (money model)
--
-- Run AFTER schema.sql and functions.sql. Safe to re-run: existing rows are
-- left untouched (on conflict do nothing), so operator-tuned settings and
-- changed passwords are never overwritten.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Settings
--   peso_rate_seconds           seconds of play time per ₱1 (360 = 6 min).
--                               Informational server-side: the client computes
--                               purchases with its own configured rate and the
--                               server records the money/time pair as sent.
--   idle_shutdown_seconds       lockscreen idle timeout before auto-shutdown
--                               (default 180 = 3 min; per-PC override lives in
--                               each PC's local settings)
--   reminder_thresholds_seconds JSON array of remaining-runway marks (seconds)
--                               at which the low-balance toast fires
-- ----------------------------------------------------------------------------
insert into public.settings (key, value) values
  ('peso_rate_seconds',           '360'),
  ('idle_shutdown_seconds',       '180'),
  ('reminder_thresholds_seconds', '[300, 60]')
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- Bootstrap admin account
--   username: admin
--   password: admin
--
-- !! CHANGE THIS PASSWORD IMMEDIATELY after first login, e.g.:
--    update public.accounts
--    set password_hash = extensions.crypt('new-password', extensions.gen_salt('bf'))
--    where username = 'admin';
-- ----------------------------------------------------------------------------
insert into public.accounts
  (username, password_hash, role, display_name, credits_centavos, time_balance_seconds)
values (
  'admin',
  extensions.crypt('admin', extensions.gen_salt('bf')),
  'admin',
  'Administrator',
  0,
  0
)
on conflict (username) do nothing;

-- ----------------------------------------------------------------------------
-- Example client account (for testing; delete in production)
--   username: client1
--   password: client1
--   starts with ₱50.00 of credits and no purchased time — buy time on the
--   lockscreen or play open time to exercise both modes.
-- ----------------------------------------------------------------------------
insert into public.accounts
  (username, password_hash, role, display_name, credits_centavos, time_balance_seconds)
values (
  'client1',
  extensions.crypt('client1', extensions.gen_salt('bf')),
  'client',
  'Client One',
  5000,
  0
)
on conflict (username) do nothing;
