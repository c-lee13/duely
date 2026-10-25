-- Database support for GitHub code submissions (additive).
--
-- A submission may now declare WHERE its code lives: a public GitHub repository and the exact commit to review.
--
--   repository_url  canonical https://github.com/<owner>/<repo>  (no .git, no trailing slash, no www, no query)
--   commit_sha      full 40-character LOWER-CASE hex SHA
--
-- Both columns are nullable and NULL for every existing submission, so text and file-based submissions are untouched.
-- Nothing is backfilled and no existing column, constraint, policy or grant changes.
--
-- Rules enforced by the database:
--   1. the URL is exactly the canonical form above (the server normalises before inserting; the database refuses anything else,
--      so the same repository can never be stored in two spellings);
--   2. the commit is a full lower-case 40-hex SHA (never a branch, tag or abbreviated SHA);
--   3. both are set, or neither is;
--   4. once a submission row exists these two values can never change, with or without an evaluation. Submissions are already
--      insert-only (submissions_immutable, migration 1: every UPDATE and DELETE is rejected). A dedicated guard on these
--      two columns is added as well, so the evidence an evaluation judged cannot be re-pointed even if that general trigger is
--      ever relaxed for some other column.
--
-- RLS and grants are unchanged: invoice parties can SELECT submissions (the new columns are plain table columns covered by the
-- existing table-level SELECT grant and the submissions_select_party policy), and nobody but the service role can write.
-- Browsers never receive INSERT/UPDATE/DELETE on this table.
--
-- Not changed here: how a submission is created or evaluated. The server API and evaluator are separate tasks.
-- Apply after migrations 1-8. Safe to run once; it is not idempotent (it adds columns and constraints by name).

alter table public.submissions
  add column repository_url text,
  add column commit_sha     text;

comment on column public.submissions.repository_url is
  'Canonical public GitHub repository URL (https://github.com/owner/repo) for a code submission; NULL for file-based submissions. Set together with commit_sha. Immutable.';
comment on column public.submissions.commit_sha is
  'Full 40-character lower-case commit SHA of the code to review; NULL for file-based submissions. Set together with repository_url. Immutable.';

alter table public.submissions
  add constraint submissions_repository_url_format check (
    repository_url is null
    or (
      repository_url ~ '^https://github\.com/[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$'
      and repository_url !~ '/\.{1,2}$'        -- the repository name cannot be "." or ".."
      and repository_url !~* '\.git$'          -- canonical form has no .git suffix
    )
  ),
  add constraint submissions_commit_sha_format check (
    commit_sha is null or commit_sha ~ '^[0-9a-f]{40}$'
  ),
  add constraint submissions_github_fields_together check (
    (repository_url is null) = (commit_sha is null)
  );

-- Defence in depth for rule 4. Fires on any UPDATE that names these columns, ahead of the general immutability trigger.
create function public.submissions_github_fields_guard()
returns trigger language plpgsql as $$
begin
  if new.repository_url is distinct from old.repository_url or new.commit_sha is distinct from old.commit_sha then
    raise exception 'submissions.repository_url and submissions.commit_sha cannot be changed once a submission exists'
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;

create trigger submissions_github_fields_immutable
  before update of repository_url, commit_sha on public.submissions
  for each row execute function public.submissions_github_fields_guard();

revoke all on function public.submissions_github_fields_guard() from public, anon, authenticated;
