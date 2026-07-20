CREATE TABLE IF NOT EXISTS discourse_capability_posts (
	session_id TEXT NOT NULL,
	sequence INTEGER NOT NULL,
	id TEXT NOT NULL,
	operation_id TEXT NOT NULL,
	command_json TEXT NOT NULL,
	forum_id TEXT NOT NULL,
	topic_id TEXT NOT NULL,
	thread_id TEXT NOT NULL,
	author_id TEXT NOT NULL,
	content_json TEXT NOT NULL,
	timestamp INTEGER NOT NULL,
	correlation_id TEXT,
	causation_id TEXT,
	reply_to_post_id TEXT,
	references_json TEXT NOT NULL,
	question_type TEXT,
	response_id TEXT,
	target_id TEXT,
	PRIMARY KEY (session_id, sequence),
	UNIQUE (session_id, id),
	UNIQUE (session_id, operation_id)
);
CREATE INDEX IF NOT EXISTS idx_discourse_capability_thread
	ON discourse_capability_posts(session_id, forum_id, topic_id, thread_id, sequence);
CREATE INDEX IF NOT EXISTS idx_discourse_capability_questions
	ON discourse_capability_posts(session_id, question_type, response_id);

CREATE TABLE IF NOT EXISTS discourse_capability_events (
	session_id TEXT NOT NULL,
	sequence INTEGER NOT NULL,
	event_json TEXT NOT NULL,
	PRIMARY KEY (session_id, sequence)
);

CREATE TABLE IF NOT EXISTS discourse_capability_cursors (
	session_id TEXT NOT NULL,
	consumer_id TEXT NOT NULL,
	sequence INTEGER NOT NULL,
	PRIMARY KEY (session_id, consumer_id)
);

CREATE TABLE IF NOT EXISTS discourse_capability_projection_cursors (
	session_id TEXT NOT NULL,
	projection_id TEXT NOT NULL,
	sequence INTEGER NOT NULL,
	PRIMARY KEY (session_id, projection_id)
);
