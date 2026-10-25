-- Wallet-verification primitives (Phase 3A).
--
-- Why in SQL: single-use consumption and one-owner-per-wallet must be ATOMIC. Doing them as separate
-- read-then-write calls from application code would allow a replayed signature or two users verifying
-- the same address to race. These functions are executable ONLY by the service role (server code);
-- browsers (anon/authenticated) cannot call them, so they cannot mint challenges or bind wallets.
-- Signature verification itself happens in server TypeScript (lib/auth/wallet-verify.ts).

-- ---------------------------------------------------------------- challenges

-- Stores a server-generated challenge. Caps open (unused, unexpired) challenges per address so the
-- table cannot be spammed, and prunes challenges that expired more than a day ago.
create or replace function public.create_wallet_challenge(
  p_address    public.evm_address,
  p_nonce      text,
  p_message    text,
  p_expires_at timestamptz
) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_open integer;
begin
  if p_expires_at <= now() or p_expires_at > now() + interval '15 minutes' then
    raise exception 'WALLET_CHALLENGE_BAD_EXPIRY' using errcode = 'P0001';
  end if;
  if length(p_nonce) < 16 then
    raise exception 'WALLET_CHALLENGE_WEAK_NONCE' using errcode = 'P0001';
  end if;

  delete from public.wallet_challenges where expires_at < now() - interval '1 day';

  select count(*) into v_open from public.wallet_challenges
   where address = p_address and used_at is null and expires_at > now();
  if v_open >= 5 then
    raise exception 'WALLET_CHALLENGE_RATE_LIMITED' using errcode = 'P0001';
  end if;

  insert into public.wallet_challenges (nonce, address, message, expires_at)
  values (p_nonce, p_address, p_message, p_expires_at);
end $$;

-- Atomically marks a challenge used and returns the exact message that was issued, or NULL when the
-- nonce is unknown, for another address, already used, or expired. Consumed even if the signature
-- later turns out invalid, so a nonce can never be tried twice.
create or replace function public.consume_wallet_challenge(
  p_nonce   text,
  p_address public.evm_address
) returns text
language plpgsql
set search_path = ''
as $$
declare
  v_message text;
begin
  update public.wallet_challenges
     set used_at = now()
   where nonce = p_nonce
     and address = p_address
     and used_at is null
     and expires_at > now()
  returning message into v_message;
  return v_message;
end $$;

-- ---------------------------------------------------------------- bindings

-- Who (if anyone) has VERIFIED ownership of this wallet.
create or replace function public.find_verified_wallet_owner(p_address public.evm_address)
returns uuid
language sql stable
set search_path = ''
as $$
  select user_id from public.user_wallets where address = p_address and verified_at is not null
$$;

-- Marks `p_address` as verified for `p_user`. Call ONLY after a signature over a consumed challenge
-- was cryptographically verified. Idempotent for the same user; refuses a wallet already verified for
-- someone else; upgrades the user's own unverified claim; caps verified wallets per user.
create or replace function public.bind_verified_wallet(
  p_user    uuid,
  p_address public.evm_address,
  p_nonce   text,
  p_method  text default 'eip191'
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_owner uuid;
  v_id    uuid;
  v_count integer;
begin
  select user_id, id into v_owner, v_id from public.user_wallets
   where address = p_address and verified_at is not null;
  if v_owner is not null then
    if v_owner <> p_user then
      raise exception 'WALLET_OWNED_BY_OTHER' using errcode = 'P0001';
    end if;
    return v_id;                                   -- already verified for this user
  end if;

  select count(*) into v_count from public.user_wallets
   where user_id = p_user and verified_at is not null;
  if v_count >= 10 then
    raise exception 'WALLET_LIMIT_REACHED' using errcode = 'P0001';
  end if;

  begin
    insert into public.user_wallets (user_id, address, verified_at, verification_method, verification_nonce)
    values (p_user, p_address, now(), p_method, p_nonce)
    on conflict (user_id, address) do update
      set verified_at = excluded.verified_at,
          verification_method = excluded.verification_method,
          verification_nonce = excluded.verification_nonce
    returning id into v_id;
  exception when unique_violation then
    -- Lost a race with another user verifying the same address.
    raise exception 'WALLET_OWNED_BY_OTHER' using errcode = 'P0001';
  end;
  return v_id;
end $$;

-- ---------------------------------------------------------------- privileges

-- Postgres grants EXECUTE to PUBLIC on every new function, which anon/authenticated inherit, and the
-- Phase 2 `revoke ... from anon, authenticated` could not remove that. Strip it from every function in
-- `public` (the trigger functions still fire; triggers do not need the invoking role to hold EXECUTE),
-- and make that the default for future functions. Then grant the four wallet functions to the
-- service role only. Written as a blanket revoke so it is valid whichever trigger functions exist.
revoke all on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public;

grant execute on function public.create_wallet_challenge(public.evm_address, text, text, timestamptz) to service_role;
grant execute on function public.consume_wallet_challenge(text, public.evm_address)                  to service_role;
grant execute on function public.find_verified_wallet_owner(public.evm_address)                      to service_role;
grant execute on function public.bind_verified_wallet(uuid, public.evm_address, text, text)          to service_role;
