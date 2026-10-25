-- Row Level Security: ENABLED with NO policies = deny-by-default.
--
-- Phase 2 intentionally grants nothing. With RLS on and zero policies, the `anon` and
-- `authenticated` roles can neither read nor write any row, even if a grant were added by
-- mistake. Only the service role (server-side code) can reach these tables, because it bypasses RLS.
-- Explicit, reviewed policies arrive in Phase 3 (a draft lives in supabase/drafts/, NOT applied).

alter table public.user_wallets      enable row level security;
alter table public.wallet_challenges enable row level security;
alter table public.invoices          enable row level security;
alter table public.invoice_criteria  enable row level security;
alter table public.transactions      enable row level security;
alter table public.submissions       enable row level security;
alter table public.evaluations       enable row level security;
alter table public.advance_requests  enable row level security;

-- FORCE makes the rule apply to the table owner too (service_role still bypasses via BYPASSRLS).
alter table public.user_wallets      force row level security;
alter table public.wallet_challenges force row level security;
alter table public.invoices          force row level security;
alter table public.invoice_criteria  force row level security;
alter table public.transactions      force row level security;
alter table public.submissions       force row level security;
alter table public.evaluations       force row level security;
alter table public.advance_requests  force row level security;

-- Belt and braces: remove Supabase's default table privileges from the public-facing roles.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
