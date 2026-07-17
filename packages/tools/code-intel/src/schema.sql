-- Knowledge Graph Schema for Code Intelligence
-- SQLite schema for storing code structure: symbols, calls, dependencies, references

-- Files table: tracks indexed files and their metadata
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  hash TEXT NOT NULL,  -- Content hash for change detection
  language TEXT,        -- typescript, javascript, python, go, rust, java
  last_indexed INTEGER NOT NULL,  -- Unix timestamp
  lines INTEGER,        -- Line count
  size_bytes INTEGER    -- File size
);

CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);

-- Symbols table: function, class, interface, type, const, variable definitions
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,  -- function, class, interface, type, const, variable, method
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_column INTEGER,
  exported BOOLEAN DEFAULT 0,
  signature TEXT,      -- Full signature/declaration
  doc_comment TEXT,    -- Documentation comment
  parent_id INTEGER REFERENCES symbols(id),  -- Parent scope (class containing method)
  UNIQUE(file_id, name, start_line)
);

CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_name_kind ON symbols(name, kind);
CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_id);
CREATE INDEX IF NOT EXISTS idx_symbols_kind_parent ON symbols(kind, parent_id);

-- Calls table: function/method call relationships
CREATE TABLE IF NOT EXISTS "calls" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  callee_name TEXT NOT NULL,     -- Name of called symbol
  callee_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,  -- Resolved target file (null if external/unresolved)
  callee_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,  -- Resolved target symbol
  call_line INTEGER NOT NULL,    -- Line where call happens
  confidence REAL DEFAULT 1.0,   -- 0.0-1.0 confidence in resolution
  dynamic INTEGER DEFAULT 0,     -- 1 if call is dynamic/runtime-resolved
  UNIQUE(caller_id, callee_name, call_line)
);

CREATE INDEX IF NOT EXISTS idx_calls_caller ON "calls"(caller_id);
CREATE INDEX IF NOT EXISTS idx_calls_callee_name ON "calls"(callee_name);
CREATE INDEX IF NOT EXISTS idx_calls_callee_symbol ON "calls"(callee_symbol_id);

-- Dependencies table: module/package import relationships
CREATE TABLE IF NOT EXISTS dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  import_path TEXT NOT NULL,     -- Import specifier (e.g., "./utils", "lodash")
  resolved_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,  -- Resolved local file
  is_external BOOLEAN DEFAULT 0, -- External package vs local module
  line INTEGER,                  -- Line of import statement
  confidence REAL DEFAULT 1.0,   -- 0.0-1.0 confidence in resolution
  dynamic INTEGER DEFAULT 0,     -- 1 if import is dynamic (require(), import())
  UNIQUE(source_file_id, import_path)
);

CREATE INDEX IF NOT EXISTS idx_dependencies_source ON dependencies(source_file_id);
CREATE INDEX IF NOT EXISTS idx_dependencies_resolved ON dependencies(resolved_file_id);
CREATE INDEX IF NOT EXISTS idx_dependencies_import ON dependencies(import_path);

-- References table: all uses of a symbol (for find-all-references)
CREATE TABLE IF NOT EXISTS "references" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line INTEGER NOT NULL,
  column INTEGER,
  context TEXT,  -- Surrounding code context
  ref_type TEXT, -- 'read', 'write', 'call', 'import', 'type_annotation'
  UNIQUE(symbol_id, file_id, line, column)
);

CREATE INDEX IF NOT EXISTS idx_references_symbol ON "references"(symbol_id);
CREATE INDEX IF NOT EXISTS idx_references_file ON "references"(file_id);

-- File hashes table: tracks file metadata for incremental change detection
CREATE TABLE IF NOT EXISTS file_hashes (
  file TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_file_hashes_hash ON file_hashes(hash);

-- Function complexity table: tracks complexity metrics for functions
CREATE TABLE IF NOT EXISTS function_complexity (
  symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  cyclomatic INTEGER DEFAULT 0,   -- Cyclomatic complexity (control flow branches)
  cognitive INTEGER DEFAULT 0,    -- Cognitive complexity (human readability)
  parameters INTEGER DEFAULT 0,   -- Number of parameters
  lines_of_code INTEGER DEFAULT 0,  -- Lines of code in function body
  max_nesting INTEGER DEFAULT 0   -- Maximum nesting depth
);

CREATE INDEX IF NOT EXISTS idx_function_complexity_cyclomatic ON function_complexity(cyclomatic);
CREATE INDEX IF NOT EXISTS idx_function_complexity_cognitive ON function_complexity(cognitive);

-- Dataflow table: tracks parameter passing and variable flows between symbols
CREATE TABLE IF NOT EXISTS dataflow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  to_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  flow_type TEXT NOT NULL,  -- 'parameter', 'return', 'assignment', 'capture'
  variable_name TEXT,        -- Name of the variable/parameter
  line INTEGER NOT NULL,     -- Line where flow occurs
  confidence REAL DEFAULT 1.0,  -- 0.0-1.0 confidence in analysis
  UNIQUE(from_symbol_id, to_symbol_id, variable_name, line)
);

CREATE INDEX IF NOT EXISTS idx_dataflow_from ON dataflow(from_symbol_id);
CREATE INDEX IF NOT EXISTS idx_dataflow_to ON dataflow(to_symbol_id);
CREATE INDEX IF NOT EXISTS idx_dataflow_type ON dataflow(flow_type);

-- Metadata table: schema version and indexing stats
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '2');
INSERT OR REPLACE INTO metadata (key, value) VALUES ('created_at', strftime('%s', 'now'));
