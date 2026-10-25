-- Evidence upload hardening (Phase 3B).
--
-- 1. Browsers can no longer create objects in the evidence bucket directly. Uploads go through
--    short-lived signed upload URLs that the SERVER mints for a server-generated path after checking the
--    session, the verified wallet and the invoice. (Reads by invoice parties stay: evidence_select_party.)
-- 2. submissions records whether funding was confirmed on-chain when the evidence was accepted, so a
--    Supabase status cache is never silently treated as proof of funding.
-- 3. submissions.mime_type is restricted to the same allow-list as the bucket.
--
-- `drop policy if exists` is a no-op when migration 6 has not been applied. If this statement fails with
-- "must be owner of table objects", drop the policy in Dashboard -> Storage -> Policies instead.

drop policy if exists evidence_insert_freelancer on storage.objects;

alter table public.submissions
  add column funding_verified_onchain boolean not null default false;
comment on column public.submissions.funding_verified_onchain is
  'true only when a trusted chain adapter confirmed the invoice was funded at submission time; false = based on the cached onchain_status only.';

alter table public.submissions
  add constraint submissions_mime_type_allowed check (mime_type in (
    'application/pdf', 'image/png', 'image/jpeg', 'application/zip',
    'application/x-zip-compressed', 'text/markdown', 'text/plain'
  ));
