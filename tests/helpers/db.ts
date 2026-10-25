import { PGlite } from "@electric-sql/pglite"
import fs from "node:fs"
import path from "node:path"

/**
 * Local Postgres (PGlite, a WASM build of real Postgres) that imitates the parts of Supabase our migrations
 * depend on: the anon / authenticated / service_role roles with Supabase's default table and function grants,
 * auth.users and auth.uid(), and storage.buckets / storage.objects with RLS on. Then the REAL migrations in
 * supabase/migrations are applied in filename order.
 *
 * Not simulated: PostgREST, GoTrue (Auth), the Storage API, JWT verification. auth.uid() reads
 * request.jwt.claim.sub, which is what Supabase's own auth.uid() reads.
 */
const MIGRATIONS = path.resolve(process.cwd(), "supabase/migrations")

/** `through` stops after that migration file (inclusive), so a test can create legacy rows before a later migration runs. */
export async function createDb(through?: string): Promise<PGlite> {
  const db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable
      as $$ select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)] $$;

    -- Supabase's defaults: everything in public (and storage) is granted to the API roles up front.
    grant usage on schema public, auth, storage to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    grant all on all tables in schema auth, storage to service_role;
    grant select on auth.users to authenticated;
    grant all on storage.objects to authenticated;       -- Supabase grants this; RLS is what restricts it
    grant select on storage.buckets to authenticated;
    grant execute on function auth.uid(), storage.foldername(text) to anon, authenticated, service_role;
  `)
  for (const f of migrationFiles()) {
    if (through && f > through) break
    await db.exec(fs.readFileSync(path.join(MIGRATIONS, f), "utf8"))
  }
  return db
}

export const migrationFiles = () => fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()

/** Applies one migration file to an existing test database. */
export async function applyMigration(db: PGlite, file: string): Promise<void> {
  await db.exec(fs.readFileSync(path.join(MIGRATIONS, file), "utf8"))
}

export type Role = "anon" | "authenticated" | "service_role"

/** Runs `fn` with the connection acting as `role` (and, for authenticated, as user `uid`), then restores it. */
export async function as<T>(db: PGlite, role: Role, uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${uid ?? ""}', false);`)
  try {
    return await fn()
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`)
  }
}

/** Resolves to the error message when the statement is rejected, or null when it succeeds. */
export async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
