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
  visitor_id uuid NOT NULL REFERENCES wb_visitors(id) ON DELETE CASCADE,
  input_tokens bigint NOT NULL DEFAULT 0 CONSTRAINT wb_tenant_usage_input_nonnegative CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CONSTRAINT wb_tenant_usage_output_nonnegative CHECK (output_tokens >= 0),
  total_tokens bigint NOT NULL DEFAULT 0 CONSTRAINT wb_tenant_usage_total_nonnegative CHECK (total_tokens >= 0),
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0 CONSTRAINT wb_tenant_usage_cost_nonnegative CHECK (cost_usd >= 0),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wb_tenant_usage_window_idx
  ON wb_tenant_usage(tenant_id, recorded_at);

-- Append-only audit trail. Rows carry stable codes and scope identifiers only:
-- no question text, prompt, provider body, token or cookie ever lands here.
CREATE TABLE IF NOT EXISTS wb_audit_events (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL CONSTRAINT wb_audit_events_tenant_id_valid CHECK (tenant_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  visitor_id uuid REFERENCES wb_visitors(id) ON DELETE SET NULL,
  action text NOT NULL CONSTRAINT wb_audit_events_action_valid CHECK (action ~ '^[a-z][a-z0-9_.]{0,63}$'),
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'denied')),
  reason_code text NOT NULL CONSTRAINT wb_audit_events_reason_code_valid CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  resource_kind text CONSTRAINT wb_audit_events_resource_kind_valid CHECK (resource_kind IS NULL OR resource_kind ~ '^[a-z][a-z0-9_]{0,31}$'),
  resource_id text CONSTRAINT wb_audit_events_resource_id_valid CHECK (resource_id IS NULL OR length(resource_id) <= 128),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wb_audit_events_tenant_idx
  ON wb_audit_events(tenant_id, created_at DESC);
`;
