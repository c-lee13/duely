-- Row Level Security policies (Phase 3A).
--
-- Model
--   * Identity = a Supabase Auth user with at least one VERIFIED wallet (user_wallets.verified_at set
--     by the server after a signature over a single-use challenge). An unverified claim, an anonymous
--     session, or a plain email account has no wallet identity and sees nothing.
--   * READ: the client and the freelancer of an invoice (matched by verified wallet address) can read
--     the invoice and everything attached to it. Unrelated wallets read nothing.
--   * WRITE: browsers get NO insert/update/delete on any table. Every write is server-controlled
--     (service role, after session + wallet + chain-state checks), including submissions, evaluation
--     results, advance requests and transactions. There are deliberately no write policies and no
--     write grants.
--   * wallet_challenges: no access for browsers at all.

-- ---------------------------------------------------------------- helpers

-- Helpers live in a schema that PostgREST does not expose, so they are not callable as /rpc endpoints.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- Verified wallet addresses of the calling user. SECURITY DEFINER so policies can read user_wallets
-- without recursing through its own RLS; search_path is pinned.
create or replace function private.my_verified_addresses()
returns setof public.evm_address
language sql stable security definer
set search_path = ''
as $$
  select address from public.user_wallets
   where user_id = (select auth.uid()) and verified_at is not null
$$;

-- True when one of the caller's VERIFIED wallets is the invoice's client or freelancer.
create or replace function private.is_invoice_party(p_invoice uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.invoices i
     where i.id = p_invoice
       and (i.client_address     in (select private.my_verified_addresses())
         or i.freelancer_address in (select private.my_verified_addresses()))
  )
$$;

revoke all on function private.my_verified_addresses()  from public, anon;
revoke all on function private.is_invoice_party(uuid)   from public, anon;
grant execute on function private.my_verified_addresses()  to authenticated;
grant execute on function private.is_invoice_party(uuid)   to authenticated;

-- ---------------------------------------------------------------- grants (read-only for browsers)

revoke all on all tables in schema public from anon, authenticated;
grant select on
  public.user_wallets, public.invoices, public.invoice_criteria, public.submissions,
  public.evaluations, public.advance_requests, public.transactions
to authenticated;
-- No grants for anon. No grants on wallet_challenges. No INSERT/UPDATE/DELETE for anyone but the service role.

-- ---------------------------------------------------------------- policies (SELECT only)

-- A user can see their own wallet rows (verified and unverified claims). Never anyone else's.
create policy user_wallets_select_own on public.user_wallets
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy invoices_select_party on public.invoices
  for select to authenticated
  using (client_address     in (select private.my_verified_addresses())
      or freelancer_address in (select private.my_verified_addresses()));

create policy invoice_criteria_select_party on public.invoice_criteria
  for select to authenticated
  using (private.is_invoice_party(invoice_uuid));

create policy submissions_select_party on public.submissions
  for select to authenticated
  using (private.is_invoice_party(invoice_uuid));

create policy evaluations_select_party on public.evaluations
  for select to authenticated
  using (private.is_invoice_party(invoice_uuid));

create policy advance_requests_select_party on public.advance_requests
  for select to authenticated
  using (private.is_invoice_party(invoice_uuid));

-- Transactions: the invoice's parties, plus rows sent from the caller's own VERIFIED wallets
-- (covers pre-registration or invoice-less transactions such as depositReserve).
create policy transactions_select_party on public.transactions
  for select to authenticated
  using ((invoice_uuid is not null and private.is_invoice_party(invoice_uuid))
      or from_address in (select private.my_verified_addresses()));
