-- =====================================================================
-- 005_status_machine — make the declared states real.
--
-- doc_status has declared seven states since 001, but only three were ever
-- written: 'extracting' by accept, then straight to 'done' or 'failed'.
-- A document being chunked and embedded reported 'extracting', which is
-- indistinguishable from being stuck — the exact failure the runner's
-- dead-job handling was added to avoid.
--
-- Additive only.
-- =====================================================================

-- When the document last moved. Time-in-stage is the first question asked
-- of a pipeline that feels slow, and updated_at cannot answer it because
-- every write touches that.
alter table documents add column if not exists status_changed_at timestamptz;
update documents set status_changed_at = updated_at where status_changed_at is null;
alter table documents alter column status_changed_at set default now();

-- Which stage failed. stage_error carries the message; without the stage,
-- a support question starts with grepping worker logs for a trace id.
alter table documents add column if not exists failed_stage text;

-- Answers "what is the pipeline doing right now" without a sequential scan
-- once the corpus is large and almost everything is done.
create index if not exists documents_in_flight_idx
  on documents (org_id, status, status_changed_at)
  where status not in ('done', 'failed');

comment on column documents.status is
  'Pipeline position. Advances only forward, via advanceStatus() in the '
  'worker — a delayed retry must never pull a document back a stage.';
