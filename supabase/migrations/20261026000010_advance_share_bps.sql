-- Client-chosen advance rate ("slider"). On-chain this is InvoiceAdvanceV2.Invoice.advanceShareBps: the share of the
-- 90% advance ceiling the freelancer may draw early, 5000..10000 bps (50% -> 45% of the invoice, 100% -> 90%).
-- The chain is authoritative; this column mirrors it (written at registration from the InvoiceCreated event) so the
-- advance_requests integrity trigger can check the amount. Legacy / V1 invoices keep 10000, which reproduces the
-- old fixed floor(amount * 90 / 100).

alter table public.invoices
  add column advance_share_bps integer not null default 10000
  check (advance_share_bps between 5000 and 10000);

comment on column public.invoices.advance_share_bps is
  'Client-chosen slider, 5000..10000 bps of the 90% advance ceiling. Mirrors InvoiceAdvanceV2.Invoice.advanceShareBps (10000 for V1).';

create or replace function public.advance_requests_guard()
returns trigger language plpgsql as $$
declare
  v_amount public.uint256;
  v_share integer;
  v_action text;
begin
  if tg_op = 'INSERT' then
    select amount, advance_share_bps into v_amount, v_share from public.invoices where id = new.invoice_uuid;
    -- floor(amount * 9000 * share / 1e8), the contract's own formula.
    if new.amount is distinct from floor(v_amount * 9000 * v_share / 100000000) then
      raise exception 'advance amount must equal floor(invoice amount * 9000 * advance_share_bps / 1e8)'
        using errcode = 'restrict_violation';
    end if;
  else
    -- What the request relied on never changes; only outcome fields may.
    if new.invoice_uuid is distinct from old.invoice_uuid
    or new.requester_user_id is distinct from old.requester_user_id
    or new.requester_address is distinct from old.requester_address
    or new.submission_id is distinct from old.submission_id
    or new.evaluation_id is distinct from old.evaluation_id
    or new.amount is distinct from old.amount
    or new.idempotency_key is distinct from old.idempotency_key then
      raise exception 'advance request basis is immutable' using errcode = 'restrict_violation';
    end if;
  end if;
  if new.transaction_id is not null then
    select action into v_action from public.transactions where id = new.transaction_id;
    if v_action is distinct from 'approveAdvance' then
      raise exception 'advance request must reference an approveAdvance transaction'
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end $$;

drop function public.register_invoice(bigint, public.evm_address, public.evm_address, text, public.evm_address, public.evm_address, text, public.bytes32_hex, text, jsonb, text, text, date, public.bytes32_hex, uuid, text, bigint);

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
  p_block         bigint,
  p_advance_share_bps integer default 10000
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
      registered_by, onchain_status, chain_synced_at, chain_synced_block, advance_share_bps
    ) values (
      p_chain_id, p_contract, p_token, p_invoice_id::public.uint256, p_client, p_freelancer, p_amount::public.uint256,
      p_criteria_hash, jsonb_array_length(p_criteria), p_canonical, p_title, p_description, p_due, p_create_tx,
      p_user, p_status, now(), p_block, p_advance_share_bps
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

revoke all on function public.register_invoice(bigint, public.evm_address, public.evm_address, text, public.evm_address, public.evm_address, text, public.bytes32_hex, text, jsonb, text, text, date, public.bytes32_hex, uuid, text, bigint, integer) from public, anon, authenticated;
grant execute on function public.register_invoice(bigint, public.evm_address, public.evm_address, text, public.evm_address, public.evm_address, text, public.bytes32_hex, text, jsonb, text, text, date, public.bytes32_hex, uuid, text, bigint, integer) to service_role;
