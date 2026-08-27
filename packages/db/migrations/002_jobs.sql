-- =====================================================================
-- 002_jobs — the queue.
--
-- DEVIATION FROM THE PLAN: a jobs table with FOR UPDATE SKIP LOCKED
-- instead of pgmq. Reasons: no extension to install, fully inspectable
-- with `select * from jobs`, and retries/heartbeat/dead-letter are ours
-- to tune. It sits behind the Queue interface in apps/worker/src/queue.ts
-- so swapping to pgmq or SQS later is one file.
-- =====================================================================

create type job_status as enum ('pending','running','done','failed','dead');

create table jobs (
  id           bigint generated always as identity primary key,
  type         text not null,
  payload      jsonb not null,
  status       job_status not null default 'pending',
  attempts     int not null default 0,
  max_attempts int not null default 5,

  run_at       timestamptz not null default now(),   -- backoff / scheduling
  locked_at    timestamptz,
  locked_by    text,
  heartbeat_at timestamptz,

  last_error   text,
  trace_id     text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- The claim index. Partial, because done/dead rows are the majority
-- within a week and we never scan them on the hot path.
create index jobs_claim_idx on jobs (run_at, id) where status = 'pending';

-- The reaper index: running jobs whose worker stopped heartbeating.
create index jobs_stale_idx on jobs (heartbeat_at) where status = 'running';

create index jobs_type_idx on jobs (type, status);

-- Idempotency: one live job per (type, dedupe_key). Lets a connector
-- sync or a re-ingest enqueue freely without piling up duplicates.
alter table jobs add column dedupe_key text;
create unique index jobs_dedupe_idx on jobs (type, dedupe_key)
  where dedupe_key is not null and status in ('pending','running');
