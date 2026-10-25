-- Migration 9: align the database with the compiled contract and isolate deployments (dUSD vs RLUSD).
--
-- ADDITIVE AND NON-DESTRUCTIVE. It only relaxes two CHECK constraints (every existing value stays valid), adds one
-- CHECK that existing rows already satisfy, and adds one index. No column is dropped or rewritten, no row is
-- touched, and it is safe to run twice. Nothing here changes who may read or write any table (RLS is untouched).
--
-- 1. invoices.onchain_status: the contract enum is Created, Funded, Advanced, Settled, Disputed, Cancelled
--    (docs/CONTRACT_SPEC.md v1.1). 'Cancelled' was missing.
-- 2. transactions.action: the contract's function names. The first draft used 'approveWork' / 'disputeInvoice';
--    those two stay allowed so old rows remain valid, but new code writes approveCompletion / raiseDispute and may also
--    write cancelInvoice, withdrawReserve and resolveDispute.
-- 3. Deployment isolation: dUSD (6 decimals) and RLUSD (18 decimals) are different (chain, InvoiceAdvance, token)
--    triples and their on-chain invoice ids repeat. A real invoice must therefore carry a real contract and token address
--    (only chain_id = 0 dev fixtures may have zero addresses), and an index makes per-deployment reads cheap. The
--    application filters every read and write by the active deployment (lib/shared/deployment-scope.ts).

-- 1 ---------------------------------------------------------------------------------------------------------------
alter table public.invoices drop constraint if exists invoices_onchain_status_check;
alter table public.invoices add constraint invoices_onchain_status_check
  check (onchain_status in ('Created','Funded','Advanced','Disputed','Settled','Cancelled'));

-- 2 ---------------------------------------------------------------------------------------------------------------
alter table public.transactions drop constraint if exists transactions_action_check;
alter table public.transactions add constraint transactions_action_check
  check (action in (
    'createInvoice','cancelInvoice','fundInvoice','depositReserve','withdrawReserve',
    'approveAdvance','approveCompletion','raiseDispute','resolveDispute',
    'approveWork','disputeInvoice'              -- legacy names, kept so existing rows stay valid
  ));

-- 3 ---------------------------------------------------------------------------------------------------------------
alter table public.invoices drop constraint if exists invoices_real_deployment_check;
alter table public.invoices add constraint invoices_real_deployment_check
  check (
    chain_id = 0
    or (contract_address <> '0x0000000000000000000000000000000000000000'
        and token_address <> '0x0000000000000000000000000000000000000000')
  );

create index if not exists invoices_deployment_idx
  on public.invoices (chain_id, contract_address, token_address);

comment on constraint invoices_real_deployment_check on public.invoices is
  'Only chain_id = 0 dev fixtures may have zero contract/token addresses; every real invoice belongs to one deployment.';
