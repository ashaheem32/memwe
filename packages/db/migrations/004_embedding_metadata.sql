-- =====================================================================
-- 004_embedding_metadata — stamp what produced each vector.
--
-- `embed_model` already existed on chunks; memories and entities had a
-- vector column and no record of where it came from. Without that, a model
-- change means re-embedding everything blind, because nothing can tell an
-- old vector from a new one.
--
-- Additive only. The 1024 dimension stays: it is what voyage-3-large,
-- gemini-embedding-001 and bge-m3 all produce, so the column does not have
-- to move when the provider does.
-- =====================================================================

alter table chunks   add column if not exists embed_dim   int;
alter table chunks   add column if not exists embedded_at timestamptz;

alter table memories add column if not exists embed_model text;
alter table memories add column if not exists embed_dim   int;
alter table memories add column if not exists embedded_at timestamptz;

alter table entities add column if not exists embed_model text;
alter table entities add column if not exists embed_dim   int;

-- The work queue for embedding: rows whose vector is missing or was made by
-- a model we are no longer using. Partial, because once a corpus is caught
-- up this index is nearly empty and stays cheap.
create index if not exists chunks_needs_embedding_idx
  on chunks (container, document_id)
  where embedding is null;

comment on column chunks.embed_model is
  'Which model produced `embedding`. Changing models means re-embedding, and '
  'this is how a dual-write migration tells the generations apart.';
