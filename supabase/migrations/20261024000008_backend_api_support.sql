-- Backend API support (Phase 4). Additive only; nothing existing is altered.
--
-- 1. register_invoice(): registers an invoice AND its frozen criteria in ONE transaction (supabase-js cannot run
--    multi-statement transactions). Service role only. Idempotent: a second registration of the same on-chain
--    invoice returns the existing row. The caller must already have verified the chain data; this function does
--    not (and cannot) talk to the chain.
-- 2. At most one live (running or completed) evaluation per submission, so concurrent or repeated evaluate requests
--    cannot create competing results. Errored evaluations do not count, so a failed run can be retried.

create unique index evaluations_one_live_per_submission_uq
  on public.evaluations (submission_id)
  where state in ('running', 'completed');

create or replace function public.register_invoice(
  p_chain_id      bigint,
  p_contract      public.evm_address,
  p_token         public.evm_address,
  p_invoice_id    text,
  p_client        public.evm_address,
  p_freelancer    public.evm_address,
  p_amount        text,
  p_criteria_hash public.bytes32_hex,
  p_canonical     text,
  p_criteria      jsonb,
  p_title         text,
  p_description   text,
  p_due           date,
  p_create_tx     public.bytes32_hex,
  p_user          uuid,
  p_status        text,
  p_block         bigint
) returns table (o_id uuid, o_created boolean)
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select i.id into v_id from public.invoices i
   where i.chain_id = p_chain_id and i.contract_address = p_contract and i.invoice_id = p_invoice_id::public.uint256;
  if v_id is not null then
    return query select v_id, false;
    return;
  end if;

  if jsonb_typeof(p_criteria) <> 'array' or jsonb_array_length(p_criteria) = 0 then
    raise exception 'REGISTER_INVOICE_NO_CRITERIA' using errcode = 'P0001';
  end if;

  begin
    insert into public.invoices (
      chain_id, contract_address, token_address, invoice_id, client_address, freelancer_address, amount,
      criteria_hash, criteria_count, criteria_canonical, title, description, due_date, create_tx_hash,
      registered_by, onchain_status, chain_synced_at, chain_synced_block
    ) values (
      p_chain_id, p_contract, p_token, p_invoice_id::public.uint256, p_client, p_freelancer, p_amount::public.uint256,
      p_criteria_hash, jsonb_array_length(p_criteria), p_canonical, p_title, p_description, p_due, p_create_tx,
      p_user, p_status, now(), p_block
    ) returning id into v_id;
  exception when unique_violation then
    -- Lost a race with a concurrent registration of the same invoice.
    select i.id into v_id from public.invoices i
     where i.chain_id = p_chain_id and i.contract_address = p_contract and i.invoice_id = p_invoice_id::public.uint256;
    return query select v_id, false;
    return;
  end;

  insert into public.invoice_criteria (invoice_uuid, position, criterion_key, text, mandatory)
  select v_id, (t.ord - 1)::integer, t.e ->> 'id', t.e ->> 'text', (t.e ->> 'mandatory')::boolean
    from jsonb_array_elements(p_criteria) with ordinality as t(e, ord);

  return query select v_id, true;
end $$;

revoke all on function public.register_invoice(bigint, public.evm_address, public.evm_address, text, public.evm_address, public.evm_address, text, public.bytes32_hex, text, jsonb, text, text, date, public.bytes32_hex, uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.register_invoice(bigint, public.evm_address, public.evm_address, text, public.evm_address, public.evm_address, text, public.bytes32_hex, text, jsonb, text, text, date, public.bytes32_hex, uuid, text, bigint) to service_role;
