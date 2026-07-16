CREATE TABLE IF NOT EXISTS discourse_posts (
	rowid INTEGER PRIMARY KEY, session_id TEXT NOT NULL, id TEXT NOT NULL, topic TEXT NOT NULL,
	thread TEXT NOT NULL, author TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL,
	reply_to_post_id TEXT, references_json TEXT NOT NULL DEFAULT '[]');
CREATE INDEX IF NOT EXISTS idx_discourse_thread ON discourse_posts(topic, thread);
CREATE INDEX IF NOT EXISTS idx_discourse_session ON discourse_posts(session_id)
