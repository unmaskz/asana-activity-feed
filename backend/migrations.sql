CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY,
  project_id TEXT,
  task_id TEXT,
  subtask_id TEXT,
  action_type TEXT,
  actor_name TEXT,
  task_name TEXT,
  subtask_name TEXT,
  comment_text TEXT,
  added_user_name TEXT,
  removed_user_name TEXT,
  from_section TEXT,
  to_section TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  raw_json JSONB
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  asana_user_id TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ
);

-- Add missing columns to existing events table if they don't exist
ALTER TABLE events ADD COLUMN IF NOT EXISTS subtask_id TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS task_name TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS subtask_name TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS comment_text TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS added_user_name TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS removed_user_name TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS from_section TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS to_section TEXT;