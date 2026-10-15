-- 0011_coach.sql: SPEC-v9 M12 Coach chat (approved by Payam 2026-10-15).
-- Three new, empty tables; nothing existing changes. A thread is one chat; a message row is one Messages API message
-- (Payam's question, an answer, or a tool round trip), so cards re-render exactly from content_json. Archived threads
-- are hidden from the list and kept; only an archived thread can be deleted for good (with its messages, attachment
-- rows and R2 objects).
CREATE TABLE coach_threads (
  id TEXT PRIMARY KEY,                                -- client ULID
  title TEXT NOT NULL,                                -- the first question, shortened to 80 characters
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,                           -- the last message; the chat list is newest first
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);
CREATE INDEX coach_threads_list ON coach_threads (archived, updated_at);

CREATE TABLE coach_messages (
  id TEXT PRIMARY KEY,                                -- client ULID for Payam's messages, server ULID otherwise
  thread_id TEXT NOT NULL REFERENCES coach_threads (id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),  -- the message's content blocks: text, image refs,
                                                      -- tool_use, tool_result (image blocks keep only the attachment id)
  created_at TEXT NOT NULL,
  input_tokens INTEGER,                               -- the API's counts for the call that wrote an assistant row
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd REAL,                                      -- from the token counts and the price table in config
  model TEXT,                                         -- the model that answered
  error TEXT                                          -- '<code>: <message>' on a failed call; content_json is then '[]'
);
CREATE INDEX coach_messages_thread ON coach_messages (thread_id, created_at);
CREATE INDEX coach_messages_created ON coach_messages (created_at);  -- this month's Coach cost line

CREATE TABLE coach_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES coach_messages (id),
  r2_key TEXT NOT NULL UNIQUE,                        -- coach/<thread_id>/<id>.jpg (private; auth-only serving)
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  source_photo_id TEXT,                               -- the progress photo it was copied from, if he picked one
  created_at TEXT NOT NULL
);
CREATE INDEX coach_attachments_message ON coach_attachments (message_id);
