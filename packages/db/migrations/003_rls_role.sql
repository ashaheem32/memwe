-- =====================================================================
-- 003_rls_role — make RLS actually enforce.
--
-- Found by tests/isolation.test.ts on day one: the policies in 001 were
-- decorative. Postgres does not apply RLS to the table OWNER, and both
-- the API and the worker were connecting as the owner. The isolation
-- test read another org's rows and passed straight through.
--
-- Fix is two roles, which is the shape you want in production anyway:
--   memwe        (owner)  — migrations, workers, metering. Bypasses RLS.
--   memwe_app    (app)    — every request-scoped read. RLS enforced.
-- =====================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'memwe_app') then
    create role memwe_app login password 'memwe_app';
  end if;
end
$$;

grant usage on schema public to memwe_app;
grant select, insert, update, delete on all tables in schema public to memwe_app;
grant usage, select on all sequences in schema public to memwe_app;

-- Future tables inherit the grants, so adding a table in Sprint 3 does
-- not silently leave the app role unable to read it.
alter default privileges in schema public
  grant select, insert, update, delete on tables to memwe_app;
alter default privileges in schema public
  grant usage, select on sequences to memwe_app;

-- FORCE makes the policies apply to the owner too. We keep the owner
-- connection for the worker (which legitimately works across tenants),
-- but nothing request-scoped may use it.
alter table documents force row level security;
alter table chunks    force row level security;
alter table memories  force row level security;

-- The owner still needs an unrestricted path for migrations and workers.
create policy owner_bypass on documents to memwe using (true) with check (true);
create policy owner_bypass on chunks    to memwe using (true) with check (true);
create policy owner_bypass on memories  to memwe using (true) with check (true);

-- And the app role gets exactly one policy: your org, nothing else.
drop policy if exists tenant_isolation on documents;
drop policy if exists tenant_isolation on chunks;
drop policy if exists tenant_isolation on memories;

create policy tenant_isolation on documents to memwe_app
  using      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
create policy tenant_isolation on chunks to memwe_app
  using      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
create policy tenant_isolation on memories to memwe_app
  using      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
