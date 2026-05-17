/**
 * StubLectorBackend — in-memory backend for tests.
 *
 * No disk I/O. Files are injected via the constructor or _injectFile().
 * Symbol extraction still runs (uses the real extractor) so symbol tests
 * get accurate results without disk access.
 */

import type {
	CallersOptions,
	CallSite,
	EditSpec,
	FindOptions,
	LectorBackend,
	ReadOptions,
	ReadResult,
	SearchMatch,
	SearchOptions,
} from "./backend.js";
import { extractBlock, extractSymbols } from "./symbol-extractor.js";

export class StubLectorBackend implements LectorBackend {
	private readonly files = new Map<string, string>();

	constructor(initial?: Record<string, string>) {
		if (initial) {
			for (const [k, v] of Object.entries(initial)) {
				this.files.set(k, v);
			}
		}
	}

	/** Inject or overwrite a file in the in-memory filesystem. */
	_injectFile(path: string, content: string): void {
		this.files.set(path, content);
	}

	async read(path: string, opts: ReadOptions = {}): Promise<ReadResult> {
		const content = this.files.get(path);
		if (content === undefined) throw new Error(`StubLectorBackend: file not found: ${path}`);

		const symbols = extractSymbols(content);
		const allLines = content.split("\n");
		const totalLines = allLines.length;

		if (opts.symbol) {
			const block = extractBlock(content, symbols, opts.symbol);
			if (!block) throw new Error(`lector.read: symbol '${opts.symbol}' not found in ${path}`);
			const maxLines = opts.maxLines ?? 300;
			const blockLines = block.content.split("\n");
			const truncated = blockLines.length > maxLines;
			return {
				path,
				content: truncated ? blockLines.slice(0, maxLines).join("\n") : block.content,
				symbols,
				totalLines,
				truncated,
			};
		}

		const maxLines = opts.maxLines ?? 2000;
		const offset = opts.offset != null ? Math.max(0, opts.offset - 1) : 0;
		const sliced = allLines.slice(offset, offset + maxLines);
		const truncated = offset + maxLines < totalLines;
		return { path, content: sliced.join("\n"), symbols, totalLines, truncated };
	}

	async write(path: string, content: string): Promise<void> {
		this.files.set(path, content);
	}

	async edit(path: string, edits: EditSpec[]): Promise<void> {
		let content = this.files.get(path);
		if (content === undefined) throw new Error(`StubLectorBackend: file not found: ${path}`);
		for (const { oldText, newText } of edits) {
			const first = content.indexOf(oldText);
			if (first === -1) throw new Error(`lector.edit: oldText not found in ${path}`);
			const last = content.lastIndexOf(oldText);
			if (first !== last) throw new Error(`lector.edit: oldText not unique in ${path}`);
			content = content.slice(0, first) + newText + content.slice(first + oldText.length);
		}
		this.files.set(path, content);
	}

	async search(pattern: string, opts: SearchOptions = {}): Promise<SearchMatch[]> {
		const re = new RegExp(pattern, opts.caseInsensitive ? "i" : "");
		const matches: SearchMatch[] = [];
		const max = opts.maxResults ?? 200;

		for (const [path, content] of this.files) {
			if (opts.extension) {
				const ext = opts.extension.replace(/^\./, "");
				if (!path.endsWith(`.${ext}`)) continue;
			}
			const lines = content.split("\n");
			for (let i = 0; i < lines.length && matches.length < max; i++) {
				if (re.test(lines[i])) {
					matches.push({ path, line: i + 1, content: lines[i] });
				}
			}
		}
		return matches;
	}

	async find(glob: string, opts: FindOptions = {}): Promise<string[]> {
		const re = new RegExp(
			`^${glob
				.replace(/[.+^${}()|[\]\\]/g, "\\$&")
				.replace(/\*/g, ".*")
				.replace(/\?/g, ".")}$`,
		);
		const max = opts.maxResults ?? 500;
		const paths: string[] = [];

		for (const path of this.files.keys()) {
			if (paths.length >= max) break;
			const name = path.split("/").pop() ?? path;
			if (re.test(name) || re.test(path)) paths.push(path);
		}
		return paths;
	}

	async callers(symbol: string, opts: CallersOptions = {}): Promise<CallSite[]> {
		const matches = await this.search(symbol, { maxResults: (opts.maxResults ?? 100) * 2 });
		const DECL_RE = new RegExp(`\\b(?:function|class|interface|type|const|let|var)\\s+${symbol}\\b`);
		const callers: CallSite[] = [];
		for (const m of matches) {
			if (callers.length >= (opts.maxResults ?? 100)) break;
			if (DECL_RE.test(m.content)) continue;
			callers.push({ path: m.path, line: m.line, context: m.content.trim() });
		}
		return callers;
	}
}
