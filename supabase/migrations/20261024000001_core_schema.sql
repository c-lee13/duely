-- Duely off-chain metadata schema.
--
-- IMPORTANT: nothing in this schema is proof that funds moved. The contract and its
-- receipts/events are authoritative for financial state. Columns that mirror chain state
-- (onchain_status, advance_amount, escrow/reserve amounts) are a CACHE written only by
-- trusted server code after verifying chain data.
--
-- Token amounts and uint256 ids use the `uint256` domain (exact NUMERIC integers, ERC-20 base units), never
-- floating point. uint256 max is 78 digits, and the `uint256` domain also bounds the value to
-- [0, 2^256 - 1]. CAUTION: PostgREST serializes `numeric` as a JSON number, which loses precision
-- above 2^53 once it reaches JavaScript. Server code must read these columns as text
-- (`select=amount::text`) or through RPC/views, and send them as decimal strings.

-- gen_random_uuid() is built into Postgres 13+, so no extension is needed.

-- ---------------------------------------------------------------- domains / helpers

-- Plain `numeric` plus an explicit integer check, NOT numeric(78,0): a scale-0 numeric silently
-- ROUNDS 1.5 to 2 on insert, which would store a different amount than was sent.
create domain public.uint256 as numeric
  check (value >= 0
     and value = trunc(value)
     and value <= 115792089237316195423570985008687907853269984665640564039457584007913129639935);

create domain public.evm_address as text
  check (value ~ '^0x[0-9a-f]{40}$');                -- stored lower-case; compare lower-case only

create domain public.bytes32_hex as text
  check (value ~ '^0x[0-9a-f]{64}$');

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- Rejects any UPDATE/DELETE. Used for records that must be immutable once written.
create or replace function public.forbid_mutation()
returns trigger language plpgsql as $$
begin
  raise exception '% on % is not allowed: records are immutable', tg_op, tg_table_name
    using errcode = 'restrict_violation';
end $$;

-- ---------------------------------------------------------------- wallets

-- Association between an authenticated user and a wallet address. A row may exist UNVERIFIED
-- (a claim); it only confers identity once `verified_at` is set. Verification (signature over a
-- single-use challenge) is performed by trusted server code in a later phase, which is the only
-- thing that may set verified_* columns. Nothing in this phase verifies anything.
create table public.user_wallets (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  address             public.evm_address not null,
  verified_at         timestamptz,
  verification_method text check (verification_method in ('eip191','eip4361')),
  verification_nonce  text,                 -- challenge that was signed (wallet_challenges.nonce)
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (user_id, address),
  check ((verified_at is null) = (verification_method is null))
);
-- A wallet can be VERIFIED for only one user; unverified claims never block the real owner.
create unique index user_wallets_verified_address_uq on public.user_wallets (address) where verified_at is not null;
create index user_wallets_user_idx    on public.user_wallets (user_id);
create index user_wallets_address_idx on public.user_wallets (address);
create trigger user_wallets_updated_at before update on public.user_wallets
  for each row execute function public.set_updated_at();

-- Once verified, ownership cannot be reassigned or un-verified in place.
create or replace function public.user_wallets_guard_verified()
returns trigger language plpgsql as $$
begin
  if old.verified_at is not null and (
       new.user_id is distinct from old.user_id
    or new.address is distinct from old.address
    or new.verified_at is distinct from old.verified_at
    or new.verification_method is distinct from old.verification_method) then
    raise exception 'verified wallet ownership is immutable' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger user_wallets_verified before update on public.user_wallets
  for each row execute function public.user_wallets_guard_verified();

-- Single-use sign-in challenges (nonces) for wallet verification. Server only.
create table public.wallet_challenges (
  nonce      text primary key,
  address    public.evm_address not null,
  message    text not null,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index wallet_challenges_address_idx on public.wallet_challenges (address);

-- ---------------------------------------------------------------- invoices

create table public.invoices (
  id                 uuid primary key default gen_random_uuid(),
  -- chain identity (on-chain invoiceId is only unique per contract deployment)
  chain_id           bigint not null,
  contract_address   public.evm_address not null,
  token_address      public.evm_address not null,
  invoice_id         public.uint256 not null,
  -- parties and terms, as read from the chain at registration
  client_address     public.evm_address not null,
  freelancer_address public.evm_address not null,
  amount             public.uint256 not null check (amount > 0),
  criteria_hash      public.bytes32_hex not null,
  criteria_version   integer not null default 1 check (criteria_version > 0),
  -- Frozen criteria set: how many invoice_criteria rows exist (and may ever exist), and the exact
  -- canonical text that was hashed into criteria_hash. The encoding is the integration owner's; the
  -- database stores it verbatim and never re-derives it. Recomputing keccak256(criteria_canonical)
  -- and comparing it with criteria_hash and with the criteria rows is the backend's job.
  criteria_count     integer not null check (criteria_count between 1 and 100),
  criteria_canonical text not null check (length(criteria_canonical) between 1 and 200000),
  -- off-chain presentation metadata
  title              text not null check (length(title) between 1 and 200),
  description        text not null default '' check (length(description) <= 4000),
  due_date           date,
  create_tx_hash     public.bytes32_hex,
  registered_by      uuid not null references auth.users (id),
  -- CACHE of chain state. Never authoritative; refreshed from verified chain reads.
  onchain_status     text not null default 'Created'
                       check (onchain_status in ('Created','Funded','Advanced','Disputed','Settled')),
  advance_amount     public.uint256 not null default 0,
  chain_synced_at    timestamptz,
  chain_synced_block bigint,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (chain_id, contract_address, invoice_id),
  check (client_address <> freelancer_address),
  check (advance_amount <= amount),
  -- Targets for composite foreign keys that pin child rows to the same invoice terms.
  unique (id, criteria_hash, criteria_version),
  unique (id, freelancer_address)
);
create index invoices_client_idx     on public.invoices (client_address);
create index invoices_freelancer_idx on public.invoices (freelancer_address);

create trigger invoices_updated_at before update on public.invoices
  for each row execute function public.set_updated_at();

-- Terms agreed on-chain can never change. Only presentation fields and the chain cache may.
create or replace function public.invoices_guard_immutable()
returns trigger language plpgsql as $$
begin
  if new.id               is distinct from old.id
  or new.chain_id         is distinct from old.chain_id
  or new.contract_address is distinct from old.contract_address
  or new.token_address    is distinct from old.token_address
  or new.invoice_id       is distinct from old.invoice_id
  or new.client_address   is distinct from old.client_address
  or new.freelancer_address is distinct from old.freelancer_address
  or new.amount           is distinct from old.amount
  or new.criteria_hash    is distinct from old.criteria_hash
  or new.criteria_version is distinct from old.criteria_version
  or new.criteria_count   is distinct from old.criteria_count
  or new.criteria_canonical is distinct from old.criteria_canonical
  or new.registered_by    is distinct from old.registered_by then
    raise exception 'invoice terms are immutable once registered'
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger invoices_immutable before update on public.invoices
  for each row execute function public.invoices_guard_immutable();
create trigger invoices_no_delete before delete on public.invoices
  for each row execute function public.forbid_mutation();

-- ---------------------------------------------------------------- frozen criteria

-- Ordered, versioned acceptance criteria. The committed on-chain hash is over exactly these
-- rows (integration owner's canonical encoding). Insert-only: never updated or deleted.
create table public.invoice_criteria (
  invoice_uuid  uuid not null references public.invoices (id),
  position      integer not null check (position >= 0),
  criterion_key text not null,               -- the `id` in the canonical {id, text} entry
  text          text not null check (length(text) between 1 and 1000),
  mandatory     boolean not null,
  created_at    timestamptz not null default now(),
  primary key (invoice_uuid, position),
  unique (invoice_uuid, criterion_key)
);
create trigger invoice_criteria_immutable before update or delete on public.invoice_criteria
  for each row execute function public.forbid_mutation();

-- No criterion can be ADDED after the fact: positions must fall inside the frozen criteria_count
-- (the primary key then makes it impossible to exceed it), so the set can never grow beyond
-- what the invoice committed to. Missing rows are caught by submissions_require_complete_criteria.
create or replace function public.invoice_criteria_guard_insert()
returns trigger language plpgsql as $$
declare
  v_count integer;
begin
  select criteria_count into v_count from public.invoices where id = new.invoice_uuid;
  if new.position >= v_count then
    raise exception 'criterion position % is outside the invoice''s frozen criteria_count (%)', new.position, v_count
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger invoice_criteria_bounded before insert on public.invoice_criteria
  for each row execute function public.invoice_criteria_guard_insert();

-- ---------------------------------------------------------------- transactions

-- Payment events. A row is `confirmed` only with a real hash and receipt data; simulated
-- (mock) rows never carry a hash and can never be confirmed chain transactions.
create table public.transactions (
  id             uuid primary key default gen_random_uuid(),
  invoice_uuid   uuid references public.invoices (id),
  chain_id       bigint not null,
  action         text not null check (action in
                   ('createInvoice','fundInvoice','depositReserve','approveAdvance','approveWork','disputeInvoice')),
  status         text not null default 'pending' check (status in ('pending','confirmed','failed')),
  from_address   public.evm_address not null,
  amount         public.uint256,
  tx_hash        public.bytes32_hex,
  block_number   bigint,
  block_hash     public.bytes32_hex,
  block_timestamp timestamptz,
  log_index      integer,
  receipt        jsonb,                       -- decoded receipt/event data used to confirm
  error          text,
  simulated      boolean not null default false,
  created_at     timestamptz not null default now(),
  confirmed_at   timestamptz,
  updated_at     timestamptz not null default now(),
  check (not simulated or tx_hash is null),
  check (status <> 'confirmed' or (tx_hash is not null and block_number is not null and confirmed_at is not null and not simulated)),
  unique (id, invoice_uuid)                    -- target for advance_requests.transaction_id
);
create unique index transactions_hash_uq on public.transactions (chain_id, tx_hash) where tx_hash is not null;
create index transactions_invoice_idx on public.transactions (invoice_uuid, created_at desc);
create index transactions_from_idx    on public.transactions (from_address);
create trigger transactions_updated_at before update on public.transactions
  for each row execute function public.set_updated_at();

-- A confirmed or failed transaction is final.
create or replace function public.transactions_guard_final()
returns trigger language plpgsql as $$
begin
  if old.status in ('confirmed','failed') and new.status is distinct from old.status then
    raise exception 'transaction is already %', old.status using errcode = 'restrict_violation';
  end if;
  if old.status = 'confirmed' and (new.tx_hash is distinct from old.tx_hash
      or new.amount is distinct from old.amount or new.action is distinct from old.action) then
    raise exception 'confirmed transactions are immutable' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger transactions_final before update on public.transactions
  for each row execute function public.transactions_guard_final();
create trigger transactions_no_delete before delete on public.transactions
  for each row execute function public.forbid_mutation();

-- ---------------------------------------------------------------- submissions

create table public.submissions (
  id                 uuid primary key default gen_random_uuid(),
  invoice_uuid       uuid not null references public.invoices (id),
  freelancer_user_id uuid not null references auth.users (id),
  freelancer_address public.evm_address not null,
  storage_path       text not null check (length(storage_path) between 1 and 1024),
  file_name          text not null check (length(file_name) between 1 and 255),
  file_size          bigint not null check (file_size > 0 and file_size <= 26214400),
  mime_type          text not null,
  note               text not null default '' check (length(note) <= 2000),
  created_at         timestamptz not null default now(),
  unique (storage_path),                         -- an object can back only one submission
  -- The submitter must be the invoice's recorded freelancer address.
  foreign key (invoice_uuid, freelancer_address) references public.invoices (id, freelancer_address),
  -- Targets for evaluations and advance requests.
  unique (id, invoice_uuid),
  unique (id, invoice_uuid, freelancer_address)
);
create index submissions_invoice_idx on public.submissions (invoice_uuid, created_at desc);
create trigger submissions_immutable before update or delete on public.submissions
  for each row execute function public.forbid_mutation();

-- Evidence (and therefore evaluations and advances) is only accepted once the invoice's frozen
-- criteria set is complete, so every evaluation is against exactly the criteria that were agreed.
create or replace function public.submissions_require_complete_criteria()
returns trigger language plpgsql as $$
declare
  v_expected integer;
  v_actual   integer;
begin
  select criteria_count into v_expected from public.invoices where id = new.invoice_uuid;
  select count(*) into v_actual from public.invoice_criteria where invoice_uuid = new.invoice_uuid;
  if v_actual is distinct from v_expected then
    raise exception 'invoice criteria are incomplete (% of % rows present)', v_actual, v_expected
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger submissions_criteria_complete before insert on public.submissions
  for each row execute function public.submissions_require_complete_criteria();

-- ---------------------------------------------------------------- evaluations

-- Server-generated only. `simulated` marks deterministic test evaluator output so it can
-- never be mistaken for a real model result.
create table public.evaluations (
  id               uuid primary key default gen_random_uuid(),
  submission_id    uuid not null references public.submissions (id),
  invoice_uuid     uuid not null references public.invoices (id),
  criteria_hash    public.bytes32_hex not null,
  criteria_version integer not null,
  model            text not null,
  prompt_version   text not null,
  state            text not null default 'running' check (state in ('running','completed','error')),
  score            integer check (score between 0 and 100),
  passed           boolean,
  -- ordered array of {criterion, passed, reason, mandatory}
  criteria_results jsonb check (criteria_results is null or jsonb_typeof(criteria_results) = 'array'),
  summary          text,
  pass_rule        text not null,
  simulated        boolean not null default false,
  error_message    text,
  created_at       timestamptz not null default now(),
  evaluated_at     timestamptz,
  check (state <> 'completed' or (score is not null and passed is not null
         and criteria_results is not null and summary is not null and evaluated_at is not null)),
  -- The evaluated submission must belong to this invoice...
  foreign key (submission_id, invoice_uuid) references public.submissions (id, invoice_uuid),
  -- ...and the hash/version it was evaluated against must be the invoice's committed ones.
  foreign key (invoice_uuid, criteria_hash, criteria_version)
    references public.invoices (id, criteria_hash, criteria_version),
  -- Target for advance_requests.
  unique (id, submission_id, invoice_uuid)
);
create index evaluations_submission_idx on public.evaluations (submission_id, created_at desc);
create index evaluations_invoice_idx    on public.evaluations (invoice_uuid, created_at desc);

-- Completed/errored evaluations are an audit record; only a running one may be finalized.
create or replace function public.evaluations_guard_final()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'evaluations cannot be deleted' using errcode = 'restrict_violation';
  end if;
  if old.state <> 'running' then
    raise exception 'evaluation is already %', old.state using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger evaluations_final before update or delete on public.evaluations
  for each row execute function public.evaluations_guard_final();

-- ---------------------------------------------------------------- advance requests

create table public.advance_requests (
  id                uuid primary key default gen_random_uuid(),
  invoice_uuid      uuid not null references public.invoices (id),
  requester_user_id uuid not null references auth.users (id),
  requester_address public.evm_address not null,
  -- The exact submission, and the evaluation OF THAT submission, this request relies on.
  submission_id     uuid not null,
  evaluation_id     uuid not null,
  status            text not null default 'pending' check (status in ('pending','paid','failed','denied')),
  amount            public.uint256 not null,         -- must equal floor(invoice amount * 90 / 100)
  reason            text,
  idempotency_key   text not null check (length(idempotency_key) between 8 and 200),
  transaction_id    uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (requester_user_id, idempotency_key),
  check (status <> 'paid' or transaction_id is not null),
  -- Submission belongs to this invoice AND was made by the requesting freelancer address.
  foreign key (submission_id, invoice_uuid, requester_address)
    references public.submissions (id, invoice_uuid, freelancer_address),
  -- Evaluation is of that submission on that invoice.
  foreign key (evaluation_id, submission_id, invoice_uuid)
    references public.evaluations (id, submission_id, invoice_uuid),
  -- Payment transaction (once set) belongs to the same invoice.
  foreign key (transaction_id, invoice_uuid) references public.transactions (id, invoice_uuid)
);
-- At most one live (pending or paid) advance per invoice; denied/failed ones may be retried.
create unique index advance_requests_one_live_uq on public.advance_requests (invoice_uuid)
  where status in ('pending','paid');
create index advance_requests_invoice_idx on public.advance_requests (invoice_uuid, created_at desc);

-- Pure integrity rules only. Whether the evaluation PASSED, is the latest, and whether the invoice is
-- eligible on-chain is deliberately NOT checked here: the authorized backend owns that decision.
create or replace function public.advance_requests_guard()
returns trigger language plpgsql as $$
declare
  v_amount public.uint256;
  v_action text;
begin
  if tg_op = 'INSERT' then
    select amount into v_amount from public.invoices where id = new.invoice_uuid;
    if new.amount is distinct from floor(v_amount * 90 / 100) then
      raise exception 'advance amount must equal floor(invoice amount * 90 / 100)'
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
create trigger advance_requests_integrity before insert or update on public.advance_requests
  for each row execute function public.advance_requests_guard();
create trigger advance_requests_updated_at before update on public.advance_requests
  for each row execute function public.set_updated_at();
create trigger advance_requests_no_delete before delete on public.advance_requests
  for each row execute function public.forbid_mutation();
