CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY,
  project_id TEXT,
  task_id TEXT,
  action_type TEXT,
  actor_name TEXT,
  raw_json JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  asana_user_id TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ
);