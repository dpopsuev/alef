/**
 * Knowledge graph backend using SQLite.
 */

import Database from "better-sqlite3";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Symbol } from "./tree-sitter-backend.js";
import { computeFileHash } from "./file-hash.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Options for GraphBackend constructor.
 */
export interface GraphBackendOptions {
	dbPath: string;
}

/**
 * SQLite-based knowledge graph backend for code intelligence.
 */
export class GraphBackend {
	private db: Database.Database;

	constructor(opts: GraphBackendOptions) {
		this.db = new Database(opts.dbPath);
		this.initialize();
	}

	private initialize(): void {
		// Load full schema from schema.sql file
		// Creates tables: files, symbols, calls, dependencies, references, file_hashes, function_complexity, dataflow, metadata
		const schemaPath = join(__dirname, "schema.sql");
		const schema = readFileSync(schemaPath, "utf-8");
		this.db.exec(schema);
	}

	indexFile(filePath: string, hash: string, language: string, symbols: Symbol[]): void {
		const insertFile = this.db.prepare(
			"INSERT OR REPLACE INTO files (path, hash, language, last_indexed) VALUES (?, ?, ?, ?)"
		);
		const result = insertFile.run(filePath, hash, language, Date.now());
		const fileId = Number(result.lastInsertRowid);

		const insertSymbol = this.db.prepare(
			"INSERT OR REPLACE INTO symbols (file_id, name, kind, start_line, end_line, start_column, exported, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
		);

		for (const sym of symbols) {
			insertSymbol.run(fileId, sym.name, sym.kind, sym.startLine, sym.endLine, sym.startColumn, 0, sym.text ?? null);
		}

		// Update file_hashes table for incremental change detection
		try {
			const stats = statSync(filePath);
			const updateHash = this.db.prepare(
				"INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)"
			);
			updateHash.run(filePath, hash, Math.floor(stats.mtimeMs), stats.size);
		} catch (_err) {
			// If we can't stat the file, skip hash update
		}
	}

	findSymbols(name: string): Array<{file: string; symbol: Symbol}> {
		type SymbolRow = {
			file: string;
			name: string;
			kind: Symbol["kind"];
			start_line: number;
			end_line: number;
			start_column: number;
		};
		const query = this.db.prepare<[string], SymbolRow>(`
			SELECT f.path as file, s.name, s.kind, s.start_line, s.end_line, s.start_column
			FROM symbols s
			JOIN files f ON s.file_id = f.id
			WHERE s.name LIKE ?
			LIMIT 100
		`);

		return query.all(`%${name}%`).map((row) => ({
			file: row.file,
			symbol: {
				name: row.name,
				kind: row.kind,
				startLine: row.start_line,
				endLine: row.end_line,
				startColumn: row.start_column,
			},
		}));
	}

	getDependencies(filePath: string): Array<{ import: string; resolved: string | null; isExternal: boolean; line: number }> {
		type DepRow = { import_path: string; resolved: string | null; is_external: number; line: number };
		const query = this.db.prepare<[string], DepRow>(`
			SELECT d.import_path, f2.path as resolved, d.is_external, d.line
			FROM dependencies d
			JOIN files f1 ON d.source_file_id = f1.id
			LEFT JOIN files f2 ON d.resolved_file_id = f2.id
			WHERE f1.path = ?
		`);
		return query.all(filePath).map((row) => ({
			import: row.import_path,
			resolved: row.resolved,
			isExternal: Boolean(row.is_external),
			line: row.line,
		}));
	}

	getReferences(symbolName: string, filePath?: string): Array<{ file: string; line: number; column: number; context: string | null; type: string | null }> {
		type RefRow = { file: string; line: number; column: number; context: string | null; ref_type: string | null };

		if (filePath) {
			const query = this.db.prepare<[string, string], RefRow>(`
				SELECT f.path as file, r.line, r.column, r.context, r.ref_type
				FROM symbol_references r
				JOIN symbols s ON r.symbol_id = s.id
				JOIN files f ON r.file_id = f.id
				JOIN files sf ON s.file_id = sf.id
				WHERE s.name = ? AND sf.path = ?
				LIMIT 500
			`);
			return query.all(symbolName, filePath).map((row) => ({
				file: row.file,
				line: row.line,
				column: row.column,
				context: row.context,
				type: row.ref_type,
			}));
		}

		const query = this.db.prepare<[string], RefRow>(`
			SELECT f.path as file, r.line, r.column, r.context, r.ref_type
			FROM symbol_references r
			JOIN symbols s ON r.symbol_id = s.id
			JOIN files f ON r.file_id = f.id
			WHERE s.name = ?
			LIMIT 500
		`);
		return query.all(symbolName).map((row) => ({
			file: row.file,
			line: row.line,
			column: row.column,
			context: row.context,
			type: row.ref_type,
		}));
	}

	getImpact(filePath: string): { dependents: string[]; affectedSymbols: Array<{ symbol: string; kind: string; callers: number }> } {
		type PathRow = { path: string };
		type AffectedRow = { name: string; kind: string; caller_count: number };

		const dependentsQuery = this.db.prepare<[string], PathRow>(`
			SELECT DISTINCT f.path
			FROM dependencies d
			JOIN files f ON d.source_file_id = f.id
			JOIN files target ON d.resolved_file_id = target.id
			WHERE target.path = ?
		`);
		const dependents = dependentsQuery.all(filePath).map((row) => row.path);

		const affectedQuery = this.db.prepare<[string], AffectedRow>(`
			SELECT s.name, s.kind, COUNT(c.id) as caller_count
			FROM symbols s
			JOIN files f ON s.file_id = f.id
			LEFT JOIN calls c ON c.callee_symbol_id = s.id
			WHERE f.path = ?
			GROUP BY s.id, s.name, s.kind
			HAVING caller_count > 0
			ORDER BY caller_count DESC
		`);
		const affectedSymbols = affectedQuery.all(filePath).map((row) => ({
			symbol: row.name,
			kind: row.kind,
			callers: row.caller_count,
		}));

		return { dependents, affectedSymbols };
	}

	/**
	 * Incrementally update the index by re-indexing only changed files.
	 * 
	 * @param workspaceRoot - Root directory to scan
	 * @param indexCallback - Callback to index a single file (filePath => void)
	 * @returns Object with changedCount and totalCount
	 */
	incrementalUpdate(workspaceRoot: string, indexCallback: (filePath: string) => void): { changedCount: number; totalCount: number } {
		const changedFiles = this.scanWorkspace(workspaceRoot);
		
		for (const file of changedFiles) {
			indexCallback(file);
		}

		return {
			changedCount: changedFiles.length,
			totalCount: this.findCodeFiles(workspaceRoot, [".ts", ".js", ".tsx", ".jsx", ".py"]).length,
		};
	}

	/**
	 * Scan workspace directory for code files and detect which have changed.
	 * 
	 * @param workspaceRoot - Root directory to scan
	 * @param extensions - File extensions to include (default: .ts, .js, .tsx, .jsx, .py)
	 * @returns List of changed file paths
	 */
	scanWorkspace(workspaceRoot: string, extensions: string[] = [".ts", ".js", ".tsx", ".jsx", ".py"]): string[] {
		const allFiles = this.findCodeFiles(workspaceRoot, extensions);
		return this.detectChangedFiles(allFiles);
	}

	/**
	 * Recursively find all code files in a directory.
	 */
	private findCodeFiles(dir: string, extensions: string[], ignore: string[] = ["node_modules", ".git", "dist", "build"]): string[] {
		const files: string[] = [];

		try {
			const entries = readdirSync(dir, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = join(dir, entry.name);

				if (entry.isDirectory()) {
					// Skip ignored directories
					if (ignore.includes(entry.name)) {
						continue;
					}
					// Recursively scan subdirectories
					files.push(...this.findCodeFiles(fullPath, extensions, ignore));
				} else if (entry.isFile()) {
					// Include files with matching extensions
					const ext = extname(entry.name);
					if (extensions.includes(ext)) {
						files.push(fullPath);
					}
				}
			}
		} catch (_err) {
			// Directory doesn't exist or can't be read, skip
		}

		return files;
	}

	/**
	 * Detect changed files using three-tier change detection:
	 * 1. Quick mtime check (cheapest)
	 * 2. Size comparison if mtime differs
	 * 3. Full hash if mtime and size differ
	 * 
	 * Returns list of files that have changed since last index.
	 */
	detectChangedFiles(files: string[]): string[] {
		const changed: string[] = [];
		type HashRow = { hash: string; mtime: number; size: number };
		const getHash = this.db.prepare<[string], HashRow>("SELECT hash, mtime, size FROM file_hashes WHERE file = ?");

		for (const file of files) {
			try {
				const stats = statSync(file);
				const currentMtime = Math.floor(stats.mtimeMs);
				const currentSize = stats.size;

				const row = getHash.get(file);

				if (!row) {
					// File never indexed
					changed.push(file);
					continue;
				}

				// Tier 1: Quick mtime check
				if (currentMtime === row.mtime) {
					// File unchanged (mtime matches)
					continue;
				}

				// Tier 2: Size check (mtime differs, check size)
				if (currentSize !== row.size) {
					// Size changed, file definitely changed
					changed.push(file);
					continue;
				}

				// Tier 3: Full hash (mtime differs but size same, need hash)
				const currentHash = computeFileHash(file);
				if (currentHash !== row.hash) {
					// Hash changed, file changed
					changed.push(file);
				}
				// else: false positive mtime change (touch/metadata update), content unchanged
			} catch (_err) {
				// File doesn't exist or can't be read, treat as changed
				changed.push(file);
			}
		}

		return changed;
	}

	close(): void {
		this.db.close();
	}
}
