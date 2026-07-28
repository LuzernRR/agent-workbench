CREATE TABLE IF NOT EXISTS search_agent_tool_operations (
  idempotency_key text PRIMARY KEY,
  run_id text NOT NULL,
  tool_call_id text NOT NULL,
  visitor_id text NOT NULL,
  project_id text,
  input_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'unknown')),
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, tool_call_id)
);

CREATE INDEX IF NOT EXISTS search_agent_tool_operations_run_idx
  ON search_agent_tool_operations (run_id, created_at);
