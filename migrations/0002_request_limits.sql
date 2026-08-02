CREATE TABLE IF NOT EXISTS request_limits (
  scope TEXT NOT NULL,
  subject TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  PRIMARY KEY (scope, subject)
);

CREATE INDEX IF NOT EXISTS idx_request_limits_window
  ON request_limits (window_started_at);
