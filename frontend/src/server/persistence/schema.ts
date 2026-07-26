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
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  archived_at timestamptz,
  UNIQUE (id, visitor_id),
  FOREIGN KEY (thread_id, visitor_id) REFERENCES wb_threads(id, visitor_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS wb_runs_thread_active_idx
  ON wb_runs(visitor_id, thread_id, created_at) WHERE archived_at IS NULL;

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
  FOREIGN KEY (run_id, visitor_id) REFERENCES wb_runs(id, visitor_id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id, visitor_id) REFERENCES wb_threads(id, visitor_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS wb_agent_events_thread_active_idx
  ON wb_agent_events(visitor_id, thread_id, seq) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS wb_agent_events_run_active_idx
  ON wb_agent_events(visitor_id, run_id, seq) WHERE archived_at IS NULL;

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
`;
