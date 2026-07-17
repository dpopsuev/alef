/**
 * Knowledge graph backend using SQLite.
 */

import Database from "better-sqlite3";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeFileHash } from "./file-hash.js";
import type { IndexedCall, IndexedImport, IndexedReference } from "./graph-types.js";
import { resolveImportPath, resolveWorkspacePath, toStoredPath } from "./path-resolve.js";
import type { Symbol } from "./tree-sitter-backend.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 *
 */
export interface GraphBackendOptions {
	dbPath: string;
}

/**
 *
 */
export interface ReplaceFileIndexInput {
	path: string;
	absolutePath: string;
	hash: string;
	language: string;
	symbols: Symbol[];
	imports: IndexedImport[];
	calls: IndexedCall[];
	references: IndexedReference[];
	lines: number;
	sizeBytes: number;
}

/**
 * SQLite-based knowledge graph backend for code intelligence.
 */
export class GraphBackend {
	private db: Database.Database;

	constructor(opts: GraphBackendOptions) {
		this.db = new Database(opts.dbPath);
		this.db.pragma("foreign_keys = ON");
		this.initialize();
	}

	private initialize(): void {
		const schemaPath = join(__dirname, "schema.sql");
		const schema = readFileSync(schemaPath, "utf-8");
		this.db.exec(schema);
	}

	/** Legacy helper used by incremental tests — symbols only. */
	indexFile(filePath: string, hash: string, language: string, symbols: Symbol[]): void {
		let size = 0;
		let mtime = Date.now();
		try {
			const stats = statSync(filePath);
			size = stats.size;
			mtime = Math.floor(stats.mtimeMs);
		} catch {
			/* optional */
		}
		this.replaceFileIndex({
			path: filePath,
			absolutePath: filePath,
			hash,
			language,
			symbols,
			imports: [],
			calls: [],
			references: [],
			lines: 0,
			sizeBytes: size,
		});
		this.db
			.prepare("INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)")
			.run(filePath, hash, mtime, size);
	}

	replaceFileIndex(input: ReplaceFileIndexInput): void {
		const tx = this.db.transaction(() => {
			this.db.prepare("DELETE FROM files WHERE path = ?").run(input.path);
			const insertFile = this.db.prepare(
				`INSERT INTO files (path, hash, language, last_indexed, lines, size_bytes)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			);
			const fileResult = insertFile.run(
				input.path,
				input.hash,
				input.language,
				Date.now(),
				input.lines,
				input.sizeBytes,
			);
			const fileId = Number(fileResult.lastInsertRowid);

			const insertSymbol = this.db.prepare(
				`INSERT INTO symbols (file_id, name, kind, start_line, end_line, start_column, exported, signature)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			const symbolIds = new Map<string, number>();
			for (const sym of input.symbols) {
				const result = insertSymbol.run(
					fileId,
					sym.name,
					sym.kind,
					sym.startLine,
					sym.endLine,
					sym.startColumn,
					0,
					sym.text ?? null,
				);
				symbolIds.set(sym.name, Number(result.lastInsertRowid));
			}

			const insertDep = this.db.prepare(
				`INSERT OR REPLACE INTO dependencies
				 (source_file_id, import_path, resolved_file_id, is_external, line, confidence, dynamic)
				 VALUES (?, ?, ?, ?, ?, 1.0, ?)`,
			);
			const findFileId = this.db.prepare<[string], { id: number }>("SELECT id FROM files WHERE path = ?");
			for (const dep of input.imports) {
				let resolvedId: number | null = null;
				if (dep.resolved) {
					resolvedId = findFileId.get(dep.resolved)?.id ?? null;
				}
				insertDep.run(
					fileId,
					dep.importPath,
					resolvedId,
					dep.isExternal ? 1 : 0,
					dep.line,
					dep.dynamic ? 1 : 0,
				);
			}

			const insertCall = this.db.prepare(
				`INSERT OR IGNORE INTO "calls"
				 (caller_id, callee_name, callee_file_id, callee_symbol_id, call_line, confidence, dynamic)
				 VALUES (?, ?, NULL, ?, ?, 1.0, 0)`,
			);
			for (const call of input.calls) {
				const callerId = symbolIds.get(call.callerName);
				if (!callerId) continue;
				const calleeId = symbolIds.get(call.calleeName) ?? null;
				insertCall.run(callerId, call.calleeName, calleeId, call.line);
			}

			const insertRef = this.db.prepare(
				`INSERT OR IGNORE INTO "references"
				 (symbol_id, file_id, line, column, context, ref_type)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			);
			for (const ref of input.references) {
				const symbolId = symbolIds.get(ref.symbolName);
				if (!symbolId) continue;
				insertRef.run(symbolId, fileId, ref.line, ref.column, ref.context, ref.refType);
			}

			let mtime = Date.now();
			try {
				mtime = Math.floor(statSync(input.absolutePath).mtimeMs);
			} catch {
				/* keep Date.now */
			}
			this.db
				.prepare("INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)")
				.run(input.absolutePath, input.hash, mtime, input.sizeBytes);
			// Also key by stored relative path for scanWorkspace results that may differ
			this.db
				.prepare("INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)")
				.run(input.path, input.hash, mtime, input.sizeBytes);
		});
		tx();
	}

	listIndexedFiles(): string[] {
		const rows = this.db.prepare<[], { path: string }>("SELECT path FROM files ORDER BY path").all();
		return rows.map((row) => row.path);
	}

	/**
	 * After a batch index, resolve dependency edges that pointed at not-yet-indexed files.
	 * Uses on-disk import resolution against cwd, then looks up the stored path.
	 */
	relinkDependencies(cwd: string): number {
		type UnresolvedDep = { id: number; import_path: string; source_path: string };
		const rows = this.db
			.prepare<[], UnresolvedDep>(
				`SELECT d.id, d.import_path, f.path as source_path
				 FROM dependencies d
				 JOIN files f ON f.id = d.source_file_id
				 WHERE d.resolved_file_id IS NULL AND d.is_external = 0`,
			)
			.all();

		const update = this.db.prepare("UPDATE dependencies SET resolved_file_id = ? WHERE id = ?");
		const findFile = this.db.prepare<[string], { id: number }>("SELECT id FROM files WHERE path = ?");
		let linked = 0;
		for (const row of rows) {
			const fromAbsolute = resolveWorkspacePath(row.source_path, cwd);
			const resolved =
				resolveImportPath(row.import_path, fromAbsolute, cwd) ??
				toStoredPath(resolveWorkspacePath(row.import_path, cwd), cwd);
			const hit = findFile.get(resolved);
			if (hit) {
				update.run(hit.id, row.id);
				linked++;
			}
		}
		return linked;
	}

	findSymbols(name: string): Array<{ file: string; symbol: Symbol }> {
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

	getDependencies(
		filePath: string,
	): Array<{ import: string; resolved: string | null; isExternal: boolean; line: number }> {
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

	getReferences(
		symbolName: string,
		filePath?: string,
	): Array<{ file: string; line: number; column: number; context: string | null; type: string | null }> {
		type RefRow = { file: string; line: number; column: number; context: string | null; ref_type: string | null };

		if (filePath) {
			const query = this.db.prepare<[string, string], RefRow>(`
				SELECT f.path as file, r.line, r.column, r.context, r.ref_type
				FROM "references" r
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
			FROM "references" r
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

	getImpact(filePath: string): {
		dependents: string[];
		affectedSymbols: Array<{ symbol: string; kind: string; callers: number }>;
	} {
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
			LEFT JOIN "calls" c ON c.callee_symbol_id = s.id
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

	incrementalUpdate(
		workspaceRoot: string,
		indexCallback: (filePath: string) => void,
	): { changedCount: number; totalCount: number } {
		const changedFiles = this.scanWorkspace(workspaceRoot);
		for (const file of changedFiles) {
			indexCallback(file);
		}
		return {
			changedCount: changedFiles.length,
			totalCount: this.findCodeFiles(workspaceRoot, [".ts", ".js", ".tsx", ".jsx", ".py"]).length,
		};
	}

	scanWorkspace(
		workspaceRoot: string,
		extensions: string[] = [".ts", ".js", ".tsx", ".jsx", ".py"],
	): string[] {
		const allFiles = this.findCodeFiles(workspaceRoot, extensions);
		return this.detectChangedFiles(allFiles);
	}

	private findCodeFiles(
		dir: string,
		extensions: string[],
		ignore: string[] = ["node_modules", ".git", "dist", "build"],
	): string[] {
		const files: string[] = [];
		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (ignore.includes(entry.name)) continue;
					files.push(...this.findCodeFiles(fullPath, extensions, ignore));
				} else if (entry.isFile()) {
					const ext = extname(entry.name);
					if (extensions.includes(ext)) files.push(fullPath);
				}
			}
		} catch {
			/* skip unreadable */
		}
		return files;
	}

	/**
	 * Three-tier change detection: mtime → size → content hash.
	 * When mtime matches but size differs (coarse FS clocks), treat as changed.
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
					changed.push(file);
					continue;
				}

				if (currentMtime === row.mtime && currentSize === row.size) {
					continue;
				}

				if (currentSize !== row.size) {
					changed.push(file);
					continue;
				}

				const currentHash = computeFileHash(file);
				if (currentHash !== row.hash) {
					changed.push(file);
				}
			} catch {
				changed.push(file);
			}
		}

		return changed;
	}

	close(): void {
		this.db.close();
	}
}
