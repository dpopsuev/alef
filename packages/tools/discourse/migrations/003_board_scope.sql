ALTER TABLE discourse_capability_posts RENAME COLUMN session_id TO board_id;
ALTER TABLE discourse_capability_events RENAME COLUMN session_id TO board_id;
ALTER TABLE discourse_capability_cursors RENAME COLUMN session_id TO board_id;
ALTER TABLE discourse_capability_projection_cursors RENAME COLUMN session_id TO board_id;

CREATE TABLE IF NOT EXISTS discourse_capability_board_lifecycle (
	board_id TEXT PRIMARY KEY,
	state TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS discourse_capability_forum_lifecycle (
	board_id TEXT NOT NULL,
	forum_id TEXT NOT NULL,
	state TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (board_id, forum_id)
);

CREATE TABLE IF NOT EXISTS discourse_capability_topic_lifecycle (
	board_id TEXT NOT NULL,
	forum_id TEXT NOT NULL,
	topic_id TEXT NOT NULL,
	state TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (board_id, forum_id, topic_id)
);

CREATE TABLE IF NOT EXISTS discourse_capability_thread_lifecycle (
	board_id TEXT NOT NULL,
	forum_id TEXT NOT NULL,
	topic_id TEXT NOT NULL,
	thread_id TEXT NOT NULL,
	state TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (board_id, forum_id, topic_id, thread_id)
);

CREATE TABLE IF NOT EXISTS discourse_capability_participants (
	board_id TEXT NOT NULL,
	forum_id TEXT NOT NULL,
	topic_id TEXT NOT NULL,
	thread_id TEXT NOT NULL,
	actor_id TEXT NOT NULL,
	mode TEXT NOT NULL,
	joined_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (board_id, forum_id, topic_id, thread_id, actor_id)
);
