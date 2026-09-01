-- =====================================================================
-- 006_dedupe_revisions — make re-ingest actually work.
--
-- Two things were broken:
--
--   1. Re-posting a customId with edited content returned a 500. The
--      unique index on (org, container, custom_id) was violated and the
--      Postgres error escaped unhandled. The documented behaviour — a
--      stable customId gives diff billing on re-ingest — did not exist.
--
--   2. Uploads never deduped. /upload stamps a placeholder hash derived
--      from the blob key, which is unique per document by construction, so
--      the same file uploaded twice was extracted, chunked and embedded
--      twice and billed twice.
-- =====================================================================

alter table documents add column if not exists revision int not null default 1;

-- A document that turned out to be bytes we already had. Kept rather than
-- deleted: the caller holds its id and deserves an answer, not a 404.
alter table documents add column if not exists duplicate_of uuid references documents(id) on delete set null;

-- Duplicates share a content hash with their original by definition, so
-- they have to sit outside the uniqueness constraint.
drop index if exists documents_hash_idx;
create unique index documents_hash_idx
  on documents (org_id, container, content_hash)
  where duplicate_of is null;

create index if not exists documents_duplicate_of_idx on documents (duplicate_of)
  where duplicate_of is not null;

-- The unit of "only re-process what changed". Editing one paragraph of a
-- 400-page report should re-embed a couple of chunks, not thousands.
alter table chunks add column if not exists text_hash bytea;
create index if not exists chunks_text_hash_idx on chunks (container, document_id, text_hash);

comment on column documents.revision is
  'Bumped when a customId is re-ingested with different content. The id is '
  'stable across revisions — that is the point of customId.';
comment on column chunks.text_hash is
  'sha256 of the chunk text. On re-chunk, a matching hash carries its '
  'embedding across so only changed regions are re-embedded.';
