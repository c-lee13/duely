-- Evidence object policies (Phase 3A). The `evidence` bucket stays private (migration 3).
--
-- Path convention, enforced here:   <invoices.id uuid>/<auth user uuid>/<filename>
--   * UPLOAD: only the invoice's freelancer (verified wallet), only into their own user folder.
--   * READ:   the invoice's client and freelancer.
--   * No UPDATE or DELETE policy: evidence is write-once, so it cannot be swapped after submission.
-- An object is not a submission. The server must still verify ownership, invoice state and file
-- metadata before it inserts a `submissions` row; nothing else may create one.

create policy evidence_insert_freelancer on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'evidence'
    and array_length(storage.foldername(name), 1) = 2
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and exists (
      select 1 from public.invoices i
       where i.id::text = (storage.foldername(name))[1]
         and i.freelancer_address in (select private.my_verified_addresses())
    )
  );

create policy evidence_select_party on storage.objects
  for select to authenticated
  using (
    bucket_id = 'evidence'
    and exists (
      select 1 from public.invoices i
       where i.id::text = (storage.foldername(name))[1]
         and (i.client_address     in (select private.my_verified_addresses())
           or i.freelancer_address in (select private.my_verified_addresses()))
    )
  );
