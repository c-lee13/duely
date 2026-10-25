-- Private evidence bucket.
--
-- Planned object path convention (enforced by Phase 3 policies):
--     <invoices.id uuid>/<auth user uuid>/<filename>
-- Evidence is never public. Reads will use short-lived signed URLs minted for an authorized
-- caller; the server (service role) performs the AI read. A storage upload alone proves nothing:
-- it only counts once the submissions API verifies ownership and invoice state.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'evidence', 'evidence', false, 26214400,
  array['application/pdf','image/png','image/jpeg','application/zip',
        'application/x-zip-compressed','text/markdown','text/plain']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- No storage.objects policies are created in Phase 2: with RLS on storage.objects this means
-- anon/authenticated cannot read or write evidence. Draft policies: supabase/drafts/phase3_policies.sql.draft
