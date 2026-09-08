-- Preserve source input across extraction retries and distinguish derived revisions.
alter table documents add column source_content text;
alter table documents add column upload_pending_key text;
update documents set source_content = markdown where blob_key is null;
alter table chunks add column revision int not null default 1;
alter table chunks add column source_ranges jsonb not null default '[]';
alter table chunks add column embedding_input_hash bytea;
create index chunks_embedding_input_idx on chunks (org_id, container, embedding_input_hash)
  where embedding is not null;

-- Scope is a literal prefix, not a LIKE pattern (container names can contain _).
create function app_container_allowed(value text) returns boolean
language sql stable as $$
  select (nullif(current_setting('app.container', true), '') is null
          or value = current_setting('app.container', true))
     and (nullif(current_setting('app.container_scope', true), '') is null
          or starts_with(value, current_setting('app.container_scope', true)))
$$;
alter policy tenant_isolation on documents
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid
         and app_container_allowed(container))
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid
              and app_container_allowed(container));
alter policy tenant_isolation on chunks
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid
         and app_container_allowed(container)
         and exists (select 1 from documents d where d.id = document_id
                     and d.revision = chunks.revision and d.status = 'done'))
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid
              and app_container_allowed(container));
alter policy tenant_isolation on memories
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid
         and app_container_allowed(container))
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid
              and app_container_allowed(container));

-- Upgrade legacy queued payloads; revision-less jobs must never run on a later revision.
update jobs set payload = payload || jsonb_build_object('revision', 1)
where payload ? 'documentId' and not payload ? 'revision';
