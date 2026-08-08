export const WORKBENCH_SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS wb_visitors (
  id uuid PRIMARY KEY,
  token_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wb_projects (
  id text PRIMARY KEY,
  visitor_id uuid NOT NULL REFERENCES wb_visitors(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  path text NOT NULL DEFAULT '',
  sort_order double precision NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, visitor_id)
);

CREATE INDEX IF NOT EXISTS wb_projects_visitor_order_idx
  ON wb_projects(visitor_id, sort_order, created_at);

CREATE TABLE IF NOT EXISTS wb_threads (
  id text PRIMARY KEY,
  visitor_id uuid NOT NULL REFERENCES wb_visitors(id) ON DELETE CASCADE,
  project_id text,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 240),
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'waiting', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_user_message_at timestamptz,
  UNIQUE (id, visitor_id),
  FOREIGN KEY (project_id, visitor_id) REFERENCES wb_projects(id, visitor_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS wb_threads_visitor_updated_idx
  ON wb_threads(visitor_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS wb_threads_project_idx
  ON wb_threads(visitor_id, project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS wb_project_memories (
  id text PRIMARY KEY,
  visitor_id uuid NOT NULL REFERENCES wb_visitors(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  source_thread_id text NOT NULL,
  source_thread_title text NOT NULL DEFAULT '会话',
  source_run_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL CHECK (length(btrim(content)) >= 1),
  content_hash char(64) NOT NULL,
  embedding vector,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_accessed_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (source_run_id, role),
  FOREIGN KEY (project_id, visitor_id) REFERENCES wb_projects(id, visitor_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS wb_project_memories_recall_idx
  ON wb_project_memories(visitor_id, project_id, created_at DESC)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS wb_project_memories_source_idx
  ON wb_project_memories(visitor_id, source_thread_id, source_run_id);

ALTER TABLE wb_project_memories
  ADD COLUMN IF NOT EXISTS source_thread_title text NOT NULL DEFAULT '会话';

UPDATE wb_project_memories memory
SET source_thread_title = thread.title
FROM wb_threads thread
WHERE memory.visitor_id = thread.visitor_id
  AND memory.source_thread_id = thread.id
  AND memory.source_thread_title = '会话';

ALTER TABLE wb_project_memories
  DROP CONSTRAINT IF EXISTS wb_project_memories_content_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wb_project_memories_content_nonempty'
  ) THEN
    ALTER TABLE wb_project_memories
      ADD CONSTRAINT wb_project_memories_content_nonempty CHECK (length(btrim(content)) >= 1);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wb_runs (
  id text PRIMARY KEY,
  visitor_id uuid NOT NULL REFERENCES wb_visitors(id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  project_id text,
  agent_id text NOT NULL,
  model_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'completed', 'failed', 'stopped')),
  execution_input jsonb NOT NULL DEFAULT '{}'::jsonb,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_epoch bigint NOT NULL DEFAULT 0 CONSTRAINT wb_runs_lease_epoch_nonnegative CHECK (lease_epoch >= 0),
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  worker_attempt integer NOT NULL DEFAULT 0 CONSTRAINT wb_runs_worker_attempt_nonnegative CHECK (worker_attempt >= 0),
  stop_requested_at timestamptz,
  revision bigint NOT NULL DEFAULT 0 CONSTRAINT wb_runs_revision_nonnegative CHECK (revision >= 0),
  checkpoint_id text,
  checkpoint_session_id text,
  checkpoint_ns text,
  checkpoint_step bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  archived_at timestamptz,
  CONSTRAINT wb_runs_checkpoint_reference_complete CHECK (
    (revision = 0 AND checkpoint_id IS NULL AND checkpoint_session_id IS NULL AND checkpoint_ns IS NULL AND checkpoint_step IS NULL)
    OR
    (revision > 0 AND checkpoint_id IS NOT NULL AND checkpoint_session_id IS NOT NULL AND checkpoint_ns IS NOT NULL AND checkpoint_step IS NOT NULL)
  ),
  CONSTRAINT wb_runs_checkpoint_id_valid CHECK (checkpoint_id IS NULL OR checkpoint_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  CONSTRAINT wb_runs_checkpoint_session_id_valid CHECK (checkpoint_session_id IS NULL OR checkpoint_session_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  CONSTRAINT wb_runs_checkpoint_ns_valid CHECK (checkpoint_ns IS NULL OR (length(checkpoint_ns) <= 256 AND checkpoint_ns !~ '[\\r\\n]')),
  CONSTRAINT wb_runs_checkpoint_step_valid CHECK (checkpoint_step IS NULL OR checkpoint_step >= -1),
  UNIQUE (id, visitor_id),
  FOREIGN KEY (thread_id, visitor_id) REFERENCES wb_threads(id, visitor_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS wb_runs_thread_active_idx
  ON wb_runs(visitor_id, thread_id, created_at) WHERE archived_at IS NULL;

ALTER TABLE wb_runs
  ADD COLUMN IF NOT EXISTS execution_input jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS worker_attempt integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stop_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS checkpoint_id text,
  ADD COLUMN IF NOT EXISTS checkpoint_session_id text,
  ADD COLUMN IF NOT EXISTS checkpoint_ns text,
  ADD COLUMN IF NOT EXISTS checkpoint_step bigint,
  ADD COLUMN IF NOT EXISTS started_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wb_runs_lease_epoch_nonnegative'
  ) THEN
    ALTER TABLE wb_runs
      ADD CONSTRAINT wb_runs_lease_epoch_nonnegative CHECK (lease_epoch >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wb_runs_worker_attempt_nonnegative'
  ) THEN
    ALTER TABLE wb_runs
      ADD CONSTRAINT wb_runs_worker_attempt_nonnegative CHECK (worker_attempt >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wb_runs_revision_nonnegative'
  ) THEN
    ALTER TABLE wb_runs
      ADD CONSTRAINT wb_runs_revision_nonnegative CHECK (revision >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wb_runs_checkpoint_reference_complete'
  ) THEN
    ALTER TABLE wb_runs
      ADD CONSTRAINT wb_runs_checkpoint_reference_complete CHECK (
        (revision = 0 AND checkpoint_id IS NULL AND checkpoint_session_id IS NULL AND checkpoint_ns IS NULL AND checkpoint_step IS NULL)
        OR
        (revision > 0 AND checkpoint_id IS NOT NULL AND checkpoint_session_id IS NOT NULL AND checkpoint_ns IS NOT NULL AND checkpoint_step IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wb_runs_checkpoint_step_valid'
  ) THEN
    ALTER TABLE wb_runs
      ADD CONSTRAINT wb_runs_checkpoint_step_valid CHECK (checkpoint_step IS NULL OR checkpoint_step >= -1);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wb_runs'::regclass AND conname = 'wb_runs_checkpoint_id_valid'
  ) THEN
    ALTER TABLE wb_runs
      ADD CONSTRAINT wb_runs_checkpoint_id_valid CHECK (checkpoint_id IS NULL OR checkpoint_id ~ '^[A-Za-z0-9_-]{1,128}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wb_runs'::regclass AND conname = 'wb_runs_checkpoint_session_id_valid'
  ) THEN
    ALTER TABLE wb_runs
      ADD CONSTRAINT wb_runs_checkpoint_session_id_valid CHECK (checkpoint_session_id IS NULL OR checkpoint_session_id ~ '^[A-Za-z0-9_-]{1,128}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wb_runs'::regclass AND conname = 'wb_runs_checkpoint_ns_valid'
  ) THEN
    ALTER TABLE wb_runs
      ADD CONSTRAINT wb_runs_checkpoint_ns_valid CHECK (checkpoint_ns IS NULL OR (length(checkpoint_ns) <= 256 AND checkpoint_ns !~ '[\\r\\n]'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wb_enforce_run_revision_monotonic()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.revision < OLD.revision OR NEW.revision > OLD.revision + 1 THEN
    RAISE EXCEPTION 'wb_runs revision must remain stable or advance by one';
  END IF;
  IF NEW.revision = OLD.revision AND ROW(
    NEW.checkpoint_id,
    NEW.checkpoint_session_id,
    NEW.checkpoint_ns,
    NEW.checkpoint_step
  ) IS DISTINCT FROM ROW(
    OLD.checkpoint_id,
    OLD.checkpoint_session_id,
    OLD.checkpoint_ns,
    OLD.checkpoint_step
  ) THEN
    RAISE EXCEPTION 'wb_runs checkpoint reference cannot change without revision';
  END IF;
  IF NEW.revision = OLD.revision + 1 AND NEW.checkpoint_id IS NOT DISTINCT FROM OLD.checkpoint_id THEN
    RAISE EXCEPTION 'wb_runs revision advance requires a new checkpoint';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'wb_runs'::regclass
      AND tgname = 'wb_runs_revision_monotonic'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER wb_runs_revision_monotonic
    BEFORE UPDATE OF revision, checkpoint_id, checkpoint_session_id, checkpoint_ns, checkpoint_step
    ON wb_runs
    FOR EACH ROW
    EXECUTE FUNCTION wb_enforce_run_revision_monotonic();
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS wb_runs_claim_idx
  ON wb_runs(available_at, created_at, id)
  WHERE archived_at IS NULL AND status IN ('queued', 'running', 'waiting');

CREATE TABLE IF NOT EXISTS wb_checkpoint_commits (
  run_id text NOT NULL,
  visitor_id uuid NOT NULL,
  revision bigint NOT NULL CONSTRAINT wb_checkpoint_commits_revision_positive CHECK (revision > 0),
  checkpoint_id text NOT NULL CONSTRAINT wb_checkpoint_commits_checkpoint_id_valid CHECK (checkpoint_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  checkpoint_session_id text NOT NULL CONSTRAINT wb_checkpoint_commits_checkpoint_session_id_valid CHECK (checkpoint_session_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  checkpoint_ns text NOT NULL CONSTRAINT wb_checkpoint_commits_checkpoint_ns_valid CHECK (length(checkpoint_ns) <= 256 AND checkpoint_ns !~ '[\\r\\n]'),
  parent_checkpoint_id text,
  step bigint NOT NULL CONSTRAINT wb_checkpoint_commits_step_valid CHECK (step >= -1),
  source_count integer NOT NULL CHECK (source_count >= 0),
  event_count integer NOT NULL CHECK (event_count >= 0),
  batch_hash char(64) NOT NULL CHECK (batch_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, checkpoint_id),
  UNIQUE (run_id, revision),
  CONSTRAINT wb_checkpoint_commits_authority_key UNIQUE (run_id, revision, checkpoint_id),
  FOREIGN KEY (run_id, visitor_id) REFERENCES wb_runs(id, visitor_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, parent_checkpoint_id) REFERENCES wb_checkpoint_commits(run_id, checkpoint_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wb_checkpoint_commits'::regclass
      AND conname = 'wb_checkpoint_commits_checkpoint_id_valid'
  ) THEN
    ALTER TABLE wb_checkpoint_commits
      ADD CONSTRAINT wb_checkpoint_commits_checkpoint_id_valid
      CHECK (checkpoint_id ~ '^[A-Za-z0-9_-]{1,128}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wb_checkpoint_commits'::regclass
      AND conname = 'wb_checkpoint_commits_checkpoint_session_id_valid'
  ) THEN
    ALTER TABLE wb_checkpoint_commits
      ADD CONSTRAINT wb_checkpoint_commits_checkpoint_session_id_valid
      CHECK (checkpoint_session_id ~ '^[A-Za-z0-9_-]{1,128}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wb_checkpoint_commits'::regclass
      AND conname = 'wb_checkpoint_commits_checkpoint_ns_valid'
  ) THEN
    ALTER TABLE wb_checkpoint_commits
      ADD CONSTRAINT wb_checkpoint_commits_checkpoint_ns_valid
      CHECK (length(checkpoint_ns) <= 256 AND checkpoint_ns !~ '[\\r\\n]');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wb_checkpoint_commits'::regclass
      AND conname = 'wb_checkpoint_commits_authority_key'
  ) THEN
    ALTER TABLE wb_checkpoint_commits
      ADD CONSTRAINT wb_checkpoint_commits_authority_key
      UNIQUE (run_id, revision, checkpoint_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wb_runs'::regclass AND conname = 'wb_runs_checkpoint_authority'
  ) THEN
    ALTER TABLE wb_runs
      ADD CONSTRAINT wb_runs_checkpoint_authority
      FOREIGN KEY (id, revision, checkpoint_id)
      REFERENCES wb_checkpoint_commits(run_id, revision, checkpoint_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS wb_checkpoint_commits_run_revision_idx
  ON wb_checkpoint_commits(run_id, revision DESC);

CREATE TABLE IF NOT EXISTS wb_source_event_inbox (
  run_id text NOT NULL,
  visitor_id uuid NOT NULL,
  checkpoint_id text NOT NULL,
  source_event_id text NOT NULL CHECK (source_event_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  source_stream_id text NOT NULL CHECK (source_stream_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  source_stream_seq integer NOT NULL CHECK (source_stream_seq > 0),
  source_type text NOT NULL,
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, source_event_id),
  UNIQUE (run_id, source_stream_id, source_stream_seq),
  FOREIGN KEY (run_id, visitor_id) REFERENCES wb_runs(id, visitor_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, checkpoint_id) REFERENCES wb_checkpoint_commits(run_id, checkpoint_id) ON DELETE CASCADE
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wb_source_event_inbox'::regclass
      AND conname = 'wb_source_event_inbox_event_id_valid'
  ) THEN
    ALTER TABLE wb_source_event_inbox
      ADD CONSTRAINT wb_source_event_inbox_event_id_valid
      CHECK (source_event_id ~ '^[A-Za-z0-9_.:-]{1,128}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wb_source_event_inbox'::regclass
      AND conname = 'wb_source_event_inbox_stream_id_valid'
  ) THEN
    ALTER TABLE wb_source_event_inbox
      ADD CONSTRAINT wb_source_event_inbox_stream_id_valid
      CHECK (source_stream_id ~ '^[A-Za-z0-9_.:-]{1,128}$');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wb_run_terminal_settlements (
  run_id text PRIMARY KEY,
  visitor_id uuid NOT NULL,
  staged_lease_owner text NOT NULL
    CONSTRAINT wb_run_terminal_settlements_staged_owner_valid
    CHECK (length(btrim(staged_lease_owner)) BETWEEN 1 AND 240),
  staged_lease_epoch bigint NOT NULL
    CONSTRAINT wb_run_terminal_settlements_staged_epoch_positive
    CHECK (staged_lease_epoch > 0),
  source_stream_id text NOT NULL
    CONSTRAINT wb_run_terminal_settlements_stream_id_valid
    CHECK (source_stream_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  source_first_seq integer NOT NULL CHECK (source_first_seq > 0),
  source_last_seq integer NOT NULL CHECK (source_last_seq >= source_first_seq),
  source_count integer NOT NULL CHECK (source_count > 0 AND source_count <= 10000),
  source_events jsonb NOT NULL CHECK (
    jsonb_typeof(source_events) = 'array'
    AND jsonb_array_length(source_events) = source_count
  ),
  projected_count integer NOT NULL CHECK (projected_count >= 0 AND projected_count <= 10000),
  projected_events jsonb NOT NULL CHECK (
    jsonb_typeof(projected_events) = 'array'
    AND jsonb_array_length(projected_events) = projected_count
  ),
  terminal_status text NOT NULL
    CONSTRAINT wb_run_terminal_settlements_terminal_status_valid
    CHECK (terminal_status IN ('failed', 'stopped')),
  stopped_payload jsonb NOT NULL CHECK (jsonb_typeof(stopped_payload) = 'object'),
  usage jsonb NOT NULL CHECK (jsonb_typeof(usage) = 'object'),
  canonical_hash char(64) NOT NULL CHECK (canonical_hash ~ '^[a-f0-9]{64}$'),
  staged_at timestamptz NOT NULL DEFAULT now(),
  settled_lease_owner text,
  settled_lease_epoch bigint,
  settled_status text,
  settled_at timestamptz,
  CONSTRAINT wb_run_terminal_settlements_identity_key
    UNIQUE (run_id, visitor_id, staged_lease_owner, staged_lease_epoch),
  CONSTRAINT wb_run_terminal_settlements_run_visitor_fk
    FOREIGN KEY (run_id, visitor_id) REFERENCES wb_runs(id, visitor_id) ON DELETE CASCADE,
  CONSTRAINT wb_run_terminal_settlements_pending_status_null CHECK (
    settled_at IS NOT NULL OR settled_status IS NULL
  ),
  CONSTRAINT wb_run_terminal_settlements_terminal_to_settled_status_valid CHECK (
    settled_at IS NULL
    OR (terminal_status = 'stopped' AND settled_status = 'stopped')
    OR (terminal_status = 'failed' AND settled_status IN ('failed', 'stopped'))
  ),
  CONSTRAINT wb_run_terminal_settlements_settled_complete CHECK (
    (settled_lease_owner IS NULL AND settled_lease_epoch IS NULL AND settled_status IS NULL AND settled_at IS NULL)
    OR
    (
      settled_lease_owner IS NOT NULL
      AND length(btrim(settled_lease_owner)) BETWEEN 1 AND 240
      AND settled_lease_epoch IS NOT NULL
      AND settled_lease_epoch >= staged_lease_epoch
      AND settled_status IS NOT NULL
      AND settled_at IS NOT NULL
      AND settled_at >= staged_at
    )
  )
);

ALTER TABLE wb_run_terminal_settlements
  ADD COLUMN IF NOT EXISTS terminal_status text NOT NULL DEFAULT 'stopped';
ALTER TABLE wb_run_terminal_settlements
  ALTER COLUMN terminal_status DROP DEFAULT;
ALTER TABLE wb_run_terminal_settlements
  ADD COLUMN IF NOT EXISTS settled_status text;
COMMENT ON COLUMN wb_run_terminal_settlements.stopped_payload IS
  'Legacy physical column name; stores the authoritative failed/stopped terminal payload.';
UPDATE wb_run_terminal_settlements
SET settled_status = NULL
WHERE settled_at IS NULL AND settled_status IS NOT NULL;
UPDATE wb_run_terminal_settlements
SET settled_status = 'stopped'
WHERE settled_at IS NOT NULL AND settled_status IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wb_run_terminal_settlements'::regclass
      AND conname = 'wb_run_terminal_settlements_terminal_status_valid'
  ) THEN
    ALTER TABLE wb_run_terminal_settlements
      ADD CONSTRAINT wb_run_terminal_settlements_terminal_status_valid
      CHECK (terminal_status IN ('failed', 'stopped'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wb_run_terminal_settlements'::regclass
      AND conname = 'wb_run_terminal_settlements_settled_status_valid'
  ) THEN
    ALTER TABLE wb_run_terminal_settlements
      ADD CONSTRAINT wb_run_terminal_settlements_settled_status_valid
      CHECK (settled_status IS NULL OR settled_status IN ('failed', 'stopped'));
  END IF;
END $$;

ALTER TABLE wb_run_terminal_settlements
  DROP CONSTRAINT IF EXISTS wb_run_terminal_settlements_status_transition_valid,
  DROP CONSTRAINT IF EXISTS wb_run_terminal_settlements_pending_status_null,
  DROP CONSTRAINT IF EXISTS wb_run_terminal_settlements_terminal_to_settled_status_valid;
ALTER TABLE wb_run_terminal_settlements
  ADD CONSTRAINT wb_run_terminal_settlements_pending_status_null CHECK (
    settled_at IS NOT NULL OR settled_status IS NULL
  );
ALTER TABLE wb_run_terminal_settlements
  ADD CONSTRAINT wb_run_terminal_settlements_terminal_to_settled_status_valid CHECK (
    settled_at IS NULL
    OR (terminal_status = 'stopped' AND settled_status = 'stopped')
    OR (terminal_status = 'failed' AND settled_status IN ('failed', 'stopped'))
  );

ALTER TABLE wb_run_terminal_settlements
  DROP CONSTRAINT IF EXISTS wb_run_terminal_settlements_settled_complete;
ALTER TABLE wb_run_terminal_settlements
  ADD CONSTRAINT wb_run_terminal_settlements_settled_complete CHECK (
    (settled_lease_owner IS NULL AND settled_lease_epoch IS NULL AND settled_status IS NULL AND settled_at IS NULL)
    OR
    (
      settled_lease_owner IS NOT NULL
      AND length(btrim(settled_lease_owner)) BETWEEN 1 AND 240
      AND settled_lease_epoch IS NOT NULL
      AND settled_lease_epoch >= staged_lease_epoch
      AND settled_status IS NOT NULL
      AND settled_at IS NOT NULL
      AND settled_at >= staged_at
    )
  );

CREATE OR REPLACE FUNCTION wb_enforce_terminal_settlement_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.run_id,
    NEW.visitor_id,
    NEW.staged_lease_owner,
    NEW.staged_lease_epoch,
    NEW.source_stream_id,
    NEW.source_first_seq,
    NEW.source_last_seq,
    NEW.source_count,
    NEW.source_events,
    NEW.projected_count,
    NEW.projected_events,
    NEW.terminal_status,
    NEW.stopped_payload,
    NEW.usage,
    NEW.canonical_hash,
    NEW.staged_at
  ) IS DISTINCT FROM ROW(
    OLD.run_id,
    OLD.visitor_id,
    OLD.staged_lease_owner,
    OLD.staged_lease_epoch,
    OLD.source_stream_id,
    OLD.source_first_seq,
    OLD.source_last_seq,
    OLD.source_count,
    OLD.source_events,
    OLD.projected_count,
    OLD.projected_events,
    OLD.terminal_status,
    OLD.stopped_payload,
    OLD.usage,
    OLD.canonical_hash,
    OLD.staged_at
  ) THEN
    RAISE EXCEPTION 'terminal settlement authority is immutable';
  END IF;
  IF OLD.settled_at IS NOT NULL AND ROW(
    NEW.settled_lease_owner,
    NEW.settled_lease_epoch,
    NEW.settled_status,
    NEW.settled_at
  ) IS DISTINCT FROM ROW(
    OLD.settled_lease_owner,
    OLD.settled_lease_epoch,
    OLD.settled_status,
    OLD.settled_at
  ) THEN
    RAISE EXCEPTION 'terminal settlement cannot be consumed twice';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'wb_run_terminal_settlements'::regclass
      AND tgname = 'wb_run_terminal_settlements_immutable'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER wb_run_terminal_settlements_immutable
    BEFORE UPDATE ON wb_run_terminal_settlements
    FOR EACH ROW
    EXECUTE FUNCTION wb_enforce_terminal_settlement_immutable();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wb_agent_events (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id text NOT NULL UNIQUE,
  visitor_id uuid NOT NULL REFERENCES wb_visitors(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  project_id text,
  thread_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT wb_agent_events_outbox_identity UNIQUE (id, visitor_id, run_id),
  FOREIGN KEY (run_id, visitor_id) REFERENCES wb_runs(id, visitor_id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id, visitor_id) REFERENCES wb_threads(id, visitor_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS wb_agent_events_thread_active_idx
  ON wb_agent_events(visitor_id, thread_id, seq) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS wb_agent_events_run_active_idx
  ON wb_agent_events(visitor_id, run_id, seq) WHERE archived_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wb_agent_events'::regclass AND conname = 'wb_agent_events_outbox_identity'
  ) THEN
    ALTER TABLE wb_agent_events
      ADD CONSTRAINT wb_agent_events_outbox_identity UNIQUE (id, visitor_id, run_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wb_agent_event_outbox (
  event_id text PRIMARY KEY,
  visitor_id uuid NOT NULL,
  run_id text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CONSTRAINT wb_agent_event_outbox_attempts_nonnegative CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wb_agent_event_outbox_event_identity
    FOREIGN KEY (event_id, visitor_id, run_id)
    REFERENCES wb_agent_events(id, visitor_id, run_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, visitor_id) REFERENCES wb_runs(id, visitor_id) ON DELETE CASCADE
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wb_agent_event_outbox'::regclass
      AND conname = 'wb_agent_event_outbox_event_identity'
  ) THEN
    ALTER TABLE wb_agent_event_outbox
      ADD CONSTRAINT wb_agent_event_outbox_event_identity
      FOREIGN KEY (event_id, visitor_id, run_id)
      REFERENCES wb_agent_events(id, visitor_id, run_id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS wb_agent_event_outbox_pending_idx
  ON wb_agent_event_outbox(available_at, created_at, event_id)
  WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS wb_attachments (
  id text PRIMARY KEY,
  visitor_id uuid NOT NULL REFERENCES wb_visitors(id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 20971520),
  kind text NOT NULL CHECK (kind IN ('image', 'document')),
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, visitor_id),
  FOREIGN KEY (thread_id, visitor_id) REFERENCES wb_threads(id, visitor_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS wb_attachments_thread_idx
  ON wb_attachments(visitor_id, thread_id, created_at);

-- Tenancy is a server-derived property of the authenticated principal, never a
-- caller-supplied field. Storing it on the visitor row makes the database the
-- single source of truth: a request can only ever act inside the tenant that
-- its own session resolves to.
ALTER TABLE wb_visitors
  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'local';

ALTER TABLE wb_visitors
  DROP CONSTRAINT IF EXISTS wb_visitors_tenant_id_valid;
ALTER TABLE wb_visitors
  ADD CONSTRAINT wb_visitors_tenant_id_valid CHECK (tenant_id ~ '^[A-Za-z0-9_-]{1,64}$');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wb_visitors'::regclass
      AND conname = 'wb_visitors_id_tenant_key'
  ) THEN
    ALTER TABLE wb_visitors
      ADD CONSTRAINT wb_visitors_id_tenant_key UNIQUE (id, tenant_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS wb_visitors_tenant_idx
  ON wb_visitors(tenant_id);

-- Per-tenant limits. Absent rows mean "use the configured default", so adding
-- the table cannot retroactively deny an existing tenant.
CREATE TABLE IF NOT EXISTS wb_tenant_quotas (
  tenant_id text PRIMARY KEY CONSTRAINT wb_tenant_quotas_tenant_id_valid CHECK (tenant_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  max_requests_per_minute integer NOT NULL CONSTRAINT wb_tenant_quotas_rpm_positive CHECK (max_requests_per_minute > 0),
  max_concurrent_runs integer NOT NULL CONSTRAINT wb_tenant_quotas_concurrency_positive CHECK (max_concurrent_runs > 0),
  max_tokens_per_day bigint NOT NULL CONSTRAINT wb_tenant_quotas_tokens_positive CHECK (max_tokens_per_day > 0),
  max_cost_usd_per_day numeric(12, 6) NOT NULL CONSTRAINT wb_tenant_quotas_cost_positive CHECK (max_cost_usd_per_day > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Usage ledger for the token and cost dimensions. run.completed already carries
-- schema-validated usage; this table is where it becomes durable and billable.
CREATE TABLE IF NOT EXISTS wb_tenant_usage (
  run_id text PRIMARY KEY,
  tenant_id text NOT NULL CONSTRAINT wb_tenant_usage_tenant_id_valid CHECK (tenant_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  visitor_id uuid NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0 CONSTRAINT wb_tenant_usage_input_nonnegative CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CONSTRAINT wb_tenant_usage_output_nonnegative CHECK (output_tokens >= 0),
  total_tokens bigint NOT NULL DEFAULT 0 CONSTRAINT wb_tenant_usage_total_nonnegative CHECK (total_tokens >= 0),
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0 CONSTRAINT wb_tenant_usage_cost_nonnegative CHECK (cost_usd >= 0),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wb_tenant_usage_visitor_tenant_fk FOREIGN KEY (visitor_id, tenant_id) REFERENCES wb_visitors(id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT wb_tenant_usage_run_visitor_fk FOREIGN KEY (run_id, visitor_id) REFERENCES wb_runs(id, visitor_id) ON DELETE CASCADE
);

-- Existing usage rows predate the composite authority keys. A Run is the
-- authority for visitor ownership, and the Visitor is the authority for its
-- tenant. Correct only rows whose ownership can be proven; an orphaned row is
-- intentionally left for the foreign-key installation to reject fail-closed.
UPDATE wb_tenant_usage AS usage
SET visitor_id = run.visitor_id,
    tenant_id = visitor.tenant_id
FROM wb_runs AS run
JOIN wb_visitors AS visitor ON visitor.id = run.visitor_id
WHERE usage.run_id = run.id
  AND (
    usage.visitor_id IS DISTINCT FROM run.visitor_id
    OR usage.tenant_id IS DISTINCT FROM visitor.tenant_id
  );

ALTER TABLE wb_tenant_usage
  DROP CONSTRAINT IF EXISTS wb_tenant_usage_visitor_id_fkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wb_tenant_usage'::regclass
      AND conname = 'wb_tenant_usage_visitor_tenant_fk'
  ) THEN
    ALTER TABLE wb_tenant_usage
      ADD CONSTRAINT wb_tenant_usage_visitor_tenant_fk
      FOREIGN KEY (visitor_id, tenant_id)
      REFERENCES wb_visitors(id, tenant_id)
      ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wb_tenant_usage'::regclass
      AND conname = 'wb_tenant_usage_run_visitor_fk'
  ) THEN
    ALTER TABLE wb_tenant_usage
      ADD CONSTRAINT wb_tenant_usage_run_visitor_fk
      FOREIGN KEY (run_id, visitor_id)
      REFERENCES wb_runs(id, visitor_id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS wb_tenant_usage_window_idx
  ON wb_tenant_usage(tenant_id, recorded_at);

-- Append-only audit trail. Rows carry stable codes and scope identifiers only:
-- no question text, prompt, provider body, token or cookie ever lands here.
CREATE TABLE IF NOT EXISTS wb_audit_events (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL CONSTRAINT wb_audit_events_tenant_id_valid CHECK (tenant_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  visitor_id uuid,
  action text NOT NULL CONSTRAINT wb_audit_events_action_valid CHECK (action ~ '^[a-z][a-z0-9_.]{0,63}$'),
  outcome text NOT NULL CONSTRAINT wb_audit_events_outcome_valid CHECK (outcome IN ('allowed', 'denied', 'queued', 'completed', 'failed', 'stopped')),
  reason_code text NOT NULL CONSTRAINT wb_audit_events_reason_code_valid CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  resource_kind text CONSTRAINT wb_audit_events_resource_kind_valid CHECK (resource_kind IS NULL OR resource_kind ~ '^[a-z][a-z0-9_]{0,31}$'),
  resource_id text CONSTRAINT wb_audit_events_resource_id_valid CHECK (resource_id IS NULL OR length(resource_id) <= 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wb_audit_events_visitor_tenant_fk FOREIGN KEY (visitor_id, tenant_id) REFERENCES wb_visitors(id, tenant_id) ON DELETE SET NULL (visitor_id)
);

-- Audit rows may outlive a deleted visitor, but every non-null visitor must
-- belong to the row's tenant. Repair legacy rows from the visitor authority
-- before installing the composite key.
UPDATE wb_audit_events AS audit
SET tenant_id = visitor.tenant_id
FROM wb_visitors AS visitor
WHERE audit.visitor_id = visitor.id
  AND audit.tenant_id IS DISTINCT FROM visitor.tenant_id;

ALTER TABLE wb_audit_events
  DROP CONSTRAINT IF EXISTS wb_audit_events_visitor_id_fkey,
  DROP CONSTRAINT IF EXISTS wb_audit_events_outcome_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wb_audit_events'::regclass
      AND conname = 'wb_audit_events_outcome_valid'
  ) THEN
    ALTER TABLE wb_audit_events
      ADD CONSTRAINT wb_audit_events_outcome_valid
      CHECK (outcome IN ('allowed', 'denied', 'queued', 'completed', 'failed', 'stopped'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wb_audit_events'::regclass
      AND conname = 'wb_audit_events_visitor_tenant_fk'
  ) THEN
    ALTER TABLE wb_audit_events
      ADD CONSTRAINT wb_audit_events_visitor_tenant_fk
      FOREIGN KEY (visitor_id, tenant_id)
      REFERENCES wb_visitors(id, tenant_id)
      ON DELETE SET NULL (visitor_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS wb_audit_events_tenant_idx
  ON wb_audit_events(tenant_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS wb_audit_events_run_queued_once_idx
  ON wb_audit_events(tenant_id, resource_id)
  WHERE action = 'run.lifecycle'
    AND resource_kind = 'run'
    AND outcome = 'queued'
    AND resource_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS wb_audit_events_run_terminal_once_idx
  ON wb_audit_events(tenant_id, resource_id)
  WHERE action = 'run.lifecycle'
    AND resource_kind = 'run'
    AND outcome IN ('completed', 'failed', 'stopped')
    AND resource_id IS NOT NULL;
`;
