-- =====================================================================
-- 001_init — the complete schema.
--
-- Ships every table and column the roadmap needs, including ones nothing
-- reads until Sprint 4/5. Deliberate: the four time columns and
-- source_spans are nearly free now and a full reprocessing job later.
--
-- After this migration: ADDITIVE CHANGES ONLY. Never rename or drop in
-- the same migration that adds. Two signatures required (Shaheem + Bru).
-- =====================================================================

create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------- enums
create type doc_status  as enum ('queued','extracting','chunking','embedding','indexing','done','failed');
create type mem_type    as enum ('fact','preference','episode','goal','relation','derived');
create type mem_rel     as enum ('updates','extends','derives','contradicts','about');
create type trust_tier  as enum ('first_party','internal','external','untrusted');
create type conn_state  as enum ('connected','backfilling','live','degraded','paused','revoked');

-- ------------------------------------------------------------- control
create table orgs (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  plan        text not null default 'free',
  created_at  timestamptz not null default now()
);

create table api_keys (
  id            uuid primary key default uuid_generate_v4(),
  org_id        uuid not null references orgs(id) on delete cascade,
  name          text not null,
  prefix        text not null,            -- first 8 chars, indexed for lookup
  hash          bytea not null,           -- sha256 of the full key
  container_scope text,                   -- null = all containers in the org
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  created_at    timestamptz not null default now()
);
create unique index api_keys_prefix_idx on api_keys (prefix) where revoked_at is null;

-- Container tags: ^[a-zA-Z0-9_:-]{1,100}$ — enforced in app AND here.
create domain container_tag as text
  check (value ~ '^[a-zA-Z0-9_:-]{1,100}$');

-- ----------------------------------------------------------- documents
create table documents (
  id            uuid primary key default uuid_generate_v4(),
  org_id        uuid not null references orgs(id) on delete cascade,
  container     container_tag not null,
  custom_id     text,
  source        text not null default 'api',
  source_uri    text,
  mime          text,
  title         text,
  blob_key      text,
  content_hash  bytea not null,
  markdown      text,
  span_map      jsonb,                     -- markdown offset -> original offset
  acl           jsonb not null default '{}'::jsonb,
  trust         trust_tier not null default 'first_party',
  metadata      jsonb not null default '{}'::jsonb,
  status        doc_status not null default 'queued',
  stage_error   text,
  token_count   int,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index documents_custom_id_idx on documents (org_id, container, custom_id) where custom_id is not null;
create unique index documents_hash_idx      on documents (org_id, container, content_hash);
create index documents_status_idx           on documents (status) where status <> 'done';
create index documents_meta_idx             on documents using gin (metadata jsonb_path_ops);

-- -------------------------------------------------------------- chunks
-- Hash-partitioned by container: isolation at the storage layer, not a
-- WHERE clause you might forget. PK must include the partition key.
create table chunks (
  id             bigint generated always as identity,
  container      container_tag not null,
  document_id    uuid not null,
  org_id         uuid not null,
  ord            int not null,
  text           text not null,
  context_header text,
  span_start     int,
  span_end       int,
  token_count    int,
  embedding      vector(1024),
  embed_model    text,
  tsv            tsvector generated always as
                   (to_tsvector('english', coalesce(context_header,'') || ' ' || text)) stored,
  created_at     timestamptz not null default now(),
  primary key (container, id)
) partition by hash (container);

create table chunks_p0 partition of chunks for values with (modulus 4, remainder 0);
create table chunks_p1 partition of chunks for values with (modulus 4, remainder 1);
create table chunks_p2 partition of chunks for values with (modulus 4, remainder 2);
create table chunks_p3 partition of chunks for values with (modulus 4, remainder 3);

create index chunks_doc_idx on chunks (document_id);
create index chunks_tsv_idx on chunks using gin (tsv);
create index chunks_vec_idx on chunks using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);

-- ------------------------------------------------------------ memories
create table memories (
  id            uuid not null default uuid_generate_v4(),
  container     container_tag not null,
  org_id        uuid not null,
  type          mem_type not null,
  statement     text not null,
  subject       text,
  predicate     text,
  object        text,
  bucket        text,
  embedding     vector(1024),
  confidence    real not null default 0.7,
  trust         trust_tier not null default 'first_party',

  -- two clocks. world time:
  valid_from    timestamptz,
  valid_to      timestamptz,
  -- system time:
  recorded_at   timestamptz not null default now(),
  invalidated_at timestamptz,

  is_latest     boolean not null default true,
  version       int not null default 1,
  root_id       uuid not null,

  access_count        int not null default 0,
  reinforcement_count int not null default 1,
  last_accessed_at    timestamptz,

  source_document_ids uuid[] not null default '{}',
  source_spans        jsonb  not null default '[]'::jsonb,
  metadata            jsonb  not null default '{}'::jsonb,
  primary key (container, id)
) partition by hash (container);

create table memories_p0 partition of memories for values with (modulus 4, remainder 0);
create table memories_p1 partition of memories for values with (modulus 4, remainder 1);
create table memories_p2 partition of memories for values with (modulus 4, remainder 2);
create table memories_p3 partition of memories for values with (modulus 4, remainder 3);

-- Partial index: the hot path is current truth, so the index stays
-- proportional to it rather than to total history.
create index memories_vec_idx    on memories using hnsw (embedding vector_cosine_ops) where is_latest;
create index memories_root_idx   on memories (container, root_id, version desc);
create index memories_subject_idx on memories (container, subject) where is_latest;
create index memories_type_idx   on memories (container, type) where is_latest;

create table memory_edges (
  container  container_tag not null,
  src_id     uuid not null,
  dst_id     uuid not null,
  rel        mem_rel not null,
  weight     real not null default 1.0,
  created_at timestamptz not null default now(),
  primary key (container, src_id, dst_id, rel),
  foreign key (container, src_id) references memories (container, id) on delete cascade,
  foreign key (container, dst_id) references memories (container, id) on delete cascade
);
create index memory_edges_dst_idx on memory_edges (container, dst_id, rel);

-- ------------------------------------------------------------- entities
create table entities (
  id         uuid primary key default uuid_generate_v4(),
  org_id     uuid not null,
  container  container_tag not null,
  canonical  text not null,
  kind       text,
  aliases    text[] not null default '{}',
  embedding  vector(1024),
  created_at timestamptz not null default now()
);
create unique index entities_canonical_idx on entities (org_id, container, lower(canonical));
create index entities_alias_idx on entities using gin (aliases);

create table memory_entities (
  container container_tag not null,
  memory_id uuid not null,
  entity_id uuid not null references entities(id) on delete cascade,
  role      text,
  primary key (container, memory_id, entity_id)
);
create index memory_entities_entity_idx on memory_entities (entity_id);

-- ------------------------------------------------------------- profiles
create table profiles (
  org_id        uuid not null,
  container     container_tag not null,
  bucket        text not null default 'preferences',
  static_facts  jsonb not null default '[]'::jsonb,
  dynamic_facts jsonb not null default '[]'::jsonb,
  rendered      text,
  updated_at    timestamptz not null default now(),
  primary key (org_id, container, bucket)
);

-- ------------------------------------- working memory (Sprint 4 uses it)
create table sessions (
  id         uuid primary key default uuid_generate_v4(),
  org_id     uuid not null,
  container  container_tag not null,
  agent_id   text,
  title      text,
  state      text not null default 'open',
  opened_at  timestamptz not null default now(),
  closed_at  timestamptz,
  promoted_at timestamptz
);
create index sessions_open_idx on sessions (org_id, container) where state = 'open';

create table session_scratch (
  id         bigint generated always as identity primary key,
  session_id uuid not null references sessions(id) on delete cascade,
  kind       text not null,          -- plan | attempt | blocker | question | note
  body       text not null,
  resolved   boolean not null default false,
  superseded_by bigint,
  created_at timestamptz not null default now()
);
create index session_scratch_open_idx on session_scratch (session_id) where not resolved;

-- ------------------------------- retrieval logging (Bet 01 — Sprint 2)
-- Collecting starts in Sprint 2 and the value is a function of elapsed
-- time. It cannot be backfilled. Do not defer turning this on.
create table retrievals (
  id          uuid primary key default uuid_generate_v4(),
  org_id      uuid not null,
  container   container_tag not null,
  session_id  uuid,
  query_hash  bytea not null,
  memory_ids  uuid[] not null default '{}',
  chunk_ids   bigint[] not null default '{}',
  ranks       int[] not null default '{}',
  mode        text,
  latency_ms  int,
  at          timestamptz not null default now()
);
create index retrievals_at_idx on retrievals (org_id, at desc);

create table retrieval_signals (
  id            bigint generated always as identity primary key,
  retrieval_id  uuid not null references retrievals(id) on delete cascade,
  memory_id     uuid,
  signal        text not null,   -- cited | rephrased | tool_ok | edited | thumbs_up | thumbs_down
  weight        real not null,
  at            timestamptz not null default now()
);
create index retrieval_signals_mem_idx on retrieval_signals (memory_id);

-- ------------------------------ injection defense (Bet 04 — Sprint 5)
create table quarantine (
  id          uuid primary key default uuid_generate_v4(),
  org_id      uuid not null,
  container   container_tag not null,
  document_id uuid references documents(id) on delete cascade,
  excerpt     text not null,
  reason      text not null,
  span_start  int,
  span_end    int,
  reviewed_at timestamptz,
  created_at  timestamptz not null default now()
);
create index quarantine_pending_idx on quarantine (org_id, container) where reviewed_at is null;

-- ----------------------------------------------------------- connectors
create table connections (
  id             uuid primary key default uuid_generate_v4(),
  org_id         uuid not null references orgs(id) on delete cascade,
  container      container_tag not null,
  provider       text not null,
  external_account text,
  credential_ref text not null,      -- vault handle. NEVER the token itself.
  cursor         jsonb,
  scope          jsonb,
  state          conn_state not null default 'connected',
  last_sync_at   timestamptz,
  next_sync_at   timestamptz,
  created_at     timestamptz not null default now()
);
create index connections_due_idx on connections (next_sync_at) where state in ('live','backfilling');

create table sync_runs (
  id            bigint generated always as identity primary key,
  connection_id uuid not null references connections(id) on delete cascade,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  upserted      int not null default 0,
  deleted       int not null default 0,
  errors        int not null default 0,
  detail        jsonb
);
create index sync_runs_conn_idx on sync_runs (connection_id, started_at desc);

-- -------------------------------------------------------------- metering
create table usage_events (
  org_id    uuid not null,
  container container_tag,
  kind      text not null,          -- ingest | distill | search | op
  units     bigint not null,
  unit_type text not null,          -- tokens | queries | ops
  cost_usd  numeric(12,6),
  at        timestamptz not null default now()
);
create index usage_events_rollup_idx on usage_events (org_id, at);

-- ------------------------------------------------------------------ RLS
-- Second lock. The query layer already filters; this is what saves you
-- when someone forgets a WHERE clause at 2am.
alter table documents enable row level security;
alter table chunks    enable row level security;
alter table memories  enable row level security;

create policy tenant_isolation on documents using (
  org_id = nullif(current_setting('app.org_id', true), '')::uuid
);
create policy tenant_isolation on chunks using (
  org_id = nullif(current_setting('app.org_id', true), '')::uuid
);
create policy tenant_isolation on memories using (
  org_id = nullif(current_setting('app.org_id', true), '')::uuid
);
