CREATE TABLE IF NOT EXISTS search_agent_tool_results (
  result_ref text PRIMARY KEY,
  run_id text NOT NULL,
  tool_call_id text NOT NULL,
  visitor_id text NOT NULL,
  project_id text,
  attempt integer NOT NULL DEFAULT 1,
  output_hash char(64) NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, tool_call_id, attempt)
);

ALTER TABLE search_agent_tool_results
  ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1;

ALTER TABLE search_agent_tool_results
  DROP CONSTRAINT IF EXISTS search_agent_tool_results_run_id_tool_call_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS search_agent_tool_results_call_attempt_idx
  ON search_agent_tool_results (run_id, tool_call_id, attempt);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'search_agent_tool_results_attempt_positive'
  ) THEN
    ALTER TABLE search_agent_tool_results
      ADD CONSTRAINT search_agent_tool_results_attempt_positive
      CHECK (attempt >= 1);
  END IF;
END $$;

ALTER TABLE search_agent_tool_operations
  ADD COLUMN IF NOT EXISTS operation_ref text,
  ADD COLUMN IF NOT EXISTS tool_id text NOT NULL DEFAULT 'web_search',
  ADD COLUMN IF NOT EXISTS tool_version text NOT NULL DEFAULT '1',
  ADD COLUMN IF NOT EXISTS plan_step_id text,
  ADD COLUMN IF NOT EXISTS research_batch_id text,
  ADD COLUMN IF NOT EXISTS research_result_id text,
  ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS output_hash char(64),
  ADD COLUMN IF NOT EXISTS result_ref text,
  ADD COLUMN IF NOT EXISTS outcome_status text,
  ADD COLUMN IF NOT EXISTS retryable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS next_action text NOT NULL DEFAULT 'stop',
  ADD COLUMN IF NOT EXISTS duration_ms integer,
  ADD COLUMN IF NOT EXISTS request_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS result_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS evidence_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS page_read_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS output_bytes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_cost_usd numeric(18, 8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS actual_cost_usd numeric(18, 8),
  ADD COLUMN IF NOT EXISTS possible_duplicate_cost_usd numeric(18, 8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

UPDATE search_agent_tool_operations
SET operation_ref = 'operation_' || left(idempotency_key, 32)
WHERE operation_ref IS NULL;

UPDATE search_agent_tool_operations
SET started_at = created_at
WHERE started_at IS NULL;

ALTER TABLE search_agent_tool_operations
  ALTER COLUMN operation_ref SET NOT NULL,
  ALTER COLUMN started_at SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'search_agent_tool_operations_attempt_positive'
  ) THEN
    ALTER TABLE search_agent_tool_operations
      ADD CONSTRAINT search_agent_tool_operations_attempt_positive
      CHECK (attempt >= 1);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'search_agent_tool_operations_counts_nonnegative'
  ) THEN
    ALTER TABLE search_agent_tool_operations
      ADD CONSTRAINT search_agent_tool_operations_counts_nonnegative
      CHECK (
        request_count >= 0
        AND result_count >= 0
        AND evidence_count >= 0
        AND page_read_count >= 0
        AND output_bytes >= 0
        AND (duration_ms IS NULL OR duration_ms >= 0)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'search_agent_tool_operations_outcome_status'
  ) THEN
    ALTER TABLE search_agent_tool_operations
      ADD CONSTRAINT search_agent_tool_operations_outcome_status
      CHECK (outcome_status IS NULL OR outcome_status IN ('success', 'degraded', 'failed'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS search_agent_tool_operations_operation_ref_idx
  ON search_agent_tool_operations (operation_ref);

CREATE INDEX IF NOT EXISTS search_agent_tool_operations_tool_call_idx
  ON search_agent_tool_operations (run_id, tool_call_id, attempt);

CREATE INDEX IF NOT EXISTS search_agent_tool_results_scope_idx
  ON search_agent_tool_results (visitor_id, run_id, created_at);
