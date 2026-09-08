-- =====================================================================
-- 008_generated_context — model-written context per chunk.
--
-- A chunk embedded on its own loses what the rest of the document said
-- about it. `context_header` (the heading path) recovers structure; this
-- adds a short model-written sentence that resolves what the chunk leaves
-- implicit. Both are prepended to the embedding input and indexed for
-- lexical search. Null means the heading path alone was used.
-- =====================================================================

alter table chunks add column generated_context text;
alter table chunks add column context_model text;

comment on column chunks.generated_context is
  'Model-written sentence(s) situating this chunk within its document. '
  'Prepended to the embedding input. Null: heading path only.';
comment on column chunks.context_model is
  'Which model wrote generated_context. A revision reuses a context only '
  'when the chunk text, heading path and this model are all unchanged.';

-- Lexical search sees the generated context too. A generated column
-- cannot be altered in place, so it is rebuilt with its index.
alter table chunks drop column tsv;
alter table chunks add column tsv tsvector generated always as
  (to_tsvector('english',
     coalesce(generated_context, '') || ' ' || coalesce(context_header, '') || ' ' || text)) stored;
create index chunks_tsv_idx on chunks using gin (tsv);
