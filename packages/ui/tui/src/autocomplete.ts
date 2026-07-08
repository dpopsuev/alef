import { spawn } from "child_process";
import { readdirSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { fuzzyFilter } from "./fuzzy.js";

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

/** Scoring rules for fuzzy file-path matching (higher weight = better match). */
const MATCH_SCORE_RULES: ReadonlyArray<{
	label: string;
	test: (fileName: string, filePath: string, query: string) => boolean;
	weight: number;
}> = [
	{ label: "exact",     test: (fn, _fp, q) => fn === q,            weight: 100 },
	{ label: "prefix",    test: (fn, _fp, q) => fn.startsWith(q),    weight: 80 },
	{ label: "substring", test: (fn, _fp, q) => fn.includes(q),      weight: 50 },
	{ label: "path",      test: (_fn, fp, q) => fp.includes(q),      weight: 30 },
];

/** Bonus applied on top of match score when the entry is a directory. */
const DIRECTORY_BONUS = 10;

/**
 *
 */
function toDisplayPath(value: string): string {
	return value.replace(/\\/g, "/");
}

/**
 *
 */
function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 *
 */
function buildFdPathQuery(query: string): string {
	const normalized = toDisplayPath(query);
	if (!normalized.includes("/")) {
		return normalized;
	}

	const hasTrailingSeparator = normalized.endsWith("/");
	const trimmed = normalized.replace(/^\/+|\/+$/g, "");
	if (!trimmed) {
		return normalized;
	}

	const separatorPattern = "[\\\\/]";
	const segments = trimmed
		.split("/")
		.filter(Boolean)
		.map((segment) => escapeRegex(segment));
	if (segments.length === 0) {
		return normalized;
	}

	let pattern = segments.join(separatorPattern);
	if (hasTrailingSeparator) {
		pattern += separatorPattern;
	}
	return pattern;
}

/**
 *
 */
function findLastDelimiter(text: string): number {
	for (let i = text.length - 1; i >= 0; i -= 1) {
		if (PATH_DELIMITERS.has(text[i] ?? "")) {
			return i;
		}
	}
	return -1;
}

/**
 *
 */
function findUnclosedQuoteStart(text: string): number | null {
	let inQuotes = false;
	let quoteStart = -1;

	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) {
				quoteStart = i;
			}
		}
	}

	return inQuotes ? quoteStart : null;
}

/**
 *
 */
function isTokenStart(text: string, index: number): boolean {
	return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

/**
 *
 */
function extractQuotedPrefix(text: string): string | null {
	const quoteStart = findUnclosedQuoteStart(text);
	if (quoteStart === null) {
		return null;
	}

	// Include the preceding "/" if it is the file-mention trigger (e.g. `/"my folder/`).
	if (quoteStart > 0 && text[quoteStart - 1] === "/" && isTokenStart(text, quoteStart - 1)) {
		return text.slice(quoteStart - 1);
	}

	if (!isTokenStart(text, quoteStart)) {
		return null;
	}

	return text.slice(quoteStart);
}

/**
 * Parses the autocomplete prefix into its constituent parts and provides
 * a wrap() helper that re-applies the trigger and quoting to a bare path.
 *
 * Handles four cases:
 *   /\"quoted path\"  → trigger="/", rawQuery="quoted path", isQuoted=true
 *   \"quoted path\"   → trigger=null, rawQuery="quoted path", isQuoted=true
 *   /path             → trigger="/", rawQuery="path",         isQuoted=false
 *   path              → trigger=null, rawQuery="path",        isQuoted=false
 *
 * Adding a new trigger (e.g. "@" for agent mentions) is one extra branch here.
 */
interface FileMentionPrefix {
	trigger: string | null;
	rawQuery: string;
	isQuoted: boolean;
	wrap(value: string): string;
}

/**
 *
 */
function parsePathPrefix(prefix: string): FileMentionPrefix {
	// wrap() only prepends the trigger character; quoting is already applied by buildCompletionValue.
	if (prefix.startsWith('/"')) {
		return { trigger: "/", rawQuery: prefix.slice(2), isQuoted: true, wrap: (v) => `/${v}` };
	}
	if (prefix.startsWith('"')) {
		return { trigger: null, rawQuery: prefix.slice(1), isQuoted: true, wrap: (v) => v };
	}
	if (prefix.startsWith("/")) {
		return { trigger: "/", rawQuery: prefix.slice(1), isQuoted: false, wrap: (v) => `/${v}` };
	}
	return { trigger: null, rawQuery: prefix, isQuoted: false, wrap: (v) => v };
}

/**
 *
 */
function buildCompletionValue(path: string, options: { isQuotedPrefix: boolean }): string {
	const needsQuotes = options.isQuotedPrefix || path.includes(" ");

	if (!needsQuotes) {
		return path;
	}

	return `"${path}"`;
}

// Use fd to walk directory tree (fast, respects .gitignore)
/**
 *
 */
async function walkDirectoryWithFd(
	baseDir: string,
	fdPath: string,
	query: string,
	maxResults: number,
	signal: AbortSignal,
): Promise<Array<{ path: string; isDirectory: boolean }>> {
	const args = [
		"--base-directory",
		baseDir,
		"--max-results",
		String(maxResults),
		"--type",
		"f",
		"--type",
		"d",
		"--follow",
		"--hidden",
		"--exclude",
		".git",
		"--exclude",
		".git/*",
		"--exclude",
		".git/**",
	];

	if (toDisplayPath(query).includes("/")) {
		args.push("--full-path");
	}

	if (query) {
		args.push(buildFdPathQuery(query));
	}

	return await new Promise((resolve) => {
		if (signal.aborted) {
			resolve([]);
			return;
		}

		const child = spawn(fdPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let resolved = false;

		const finish = (results: Array<{ path: string; isDirectory: boolean }>) => {
			if (resolved) return;
			resolved = true;
			signal.removeEventListener("abort", onAbort);
			resolve(results);
		};

		const onAbort = () => {
			if (child.exitCode === null) {
				child.kill("SIGKILL");
			}
		};

		signal.addEventListener("abort", onAbort, { once: true });
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => {
			finish([]);
		});
		child.on("close", (code) => {
			if (signal.aborted || code !== 0 || !stdout) {
				finish([]);
				return;
			}

			const lines = stdout.trim().split("\n").filter(Boolean);
			const results: Array<{ path: string; isDirectory: boolean }> = [];

			for (const line of lines) {
				const displayLine = toDisplayPath(line);
				const hasTrailingSeparator = displayLine.endsWith("/");
				const normalizedPath = hasTrailingSeparator ? displayLine.slice(0, -1) : displayLine;
				if (normalizedPath === ".git" || normalizedPath.startsWith(".git/") || normalizedPath.includes("/.git/")) {
					continue;
				}

				results.push({
					path: displayLine,
					isDirectory: hasTrailingSeparator,
				});
			}

			finish(results);
		});
	});
}

/**
 *
 */
export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
}

type Awaitable<T> = T | Promise<T>;

/**
 *
 */
export interface SlashCommand {
	name: string;
	description?: string;
	argumentHint?: string;
	getArgumentCompletions?(argumentPrefix: string): Awaitable<AutocompleteItem[] | null>;
}

/**
 *
 */
export interface AutocompleteSuggestions {
	items: AutocompleteItem[];
	prefix: string; // What we're matching against (e.g., "/" or "src/")
}

/**
 *
 */
export interface AutocompleteProvider {
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null>;

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
	};

	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

/**
 *
 */
export class CombinedAutocompleteProvider implements AutocompleteProvider {
	private commands: (SlashCommand | AutocompleteItem)[];
	private basePath: string;
	private fdPath: string | null;

	constructor(commands: (SlashCommand | AutocompleteItem)[] = [], basePath: string, fdPath: string | null = null) {
		this.commands = commands;
		this.basePath = basePath;
		this.fdPath = fdPath;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const currentLine = lines[cursorLine] ?? "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		if (!options.force && textBeforeCursor.startsWith(":")) {
			const spaceIndex = textBeforeCursor.indexOf(" ");

			if (spaceIndex === -1) {
				const prefix = textBeforeCursor.slice(1);
				const commandItems = this.commands.map((cmd) => {
					const name = "name" in cmd ? cmd.name : cmd.value;
					const hint = "argumentHint" in cmd && cmd.argumentHint ? cmd.argumentHint : undefined;
					const desc = cmd.description ?? "";
					const fullDesc = hint ? (desc ? `${hint} — ${desc}` : hint) : desc;
					return {
						name,
						label: name,
						description: fullDesc || undefined,
					};
				});

				const filtered = fuzzyFilter(commandItems, prefix, (item) => item.name).map((item) => ({
					value: item.name,
					label: item.label,
					...(item.description && { description: item.description }),
				}));

				if (filtered.length === 0) return null;

				return {
					items: filtered,
					prefix: textBeforeCursor,
				};
			}

			const commandName = textBeforeCursor.slice(1, spaceIndex);
			const argumentText = textBeforeCursor.slice(spaceIndex + 1);

			const command = this.commands.find((cmd) => {
				const name = "name" in cmd ? cmd.name : cmd.value;
				return name === commandName;
			});
			if (!command || !("getArgumentCompletions" in command) || !command.getArgumentCompletions) {
				return null;
			}

			const argumentSuggestions = await command.getArgumentCompletions(argumentText);
			if (!Array.isArray(argumentSuggestions) || argumentSuggestions.length === 0) {
				return null;
			}

			return {
				items: argumentSuggestions,
				prefix: argumentText,
			};
		}

		const pathMatch = this.extractPathPrefix(textBeforeCursor, options.force ?? false);
		if (pathMatch === null) {
			return null;
		}

		const mention = parsePathPrefix(pathMatch);
		// Use fd even for empty trigger query so .git is excluded via fd's default behaviour.
		const suggestions =
			!options.force && this.fdPath && (mention.rawQuery.length > 0 || mention.trigger !== null)
				? await this.getFuzzyFileSuggestions(mention.rawQuery, {
						isQuotedPrefix: mention.isQuoted,
						signal: options.signal,
					})
				: this.getFileSuggestions(pathMatch);
		if (options.signal.aborted) {
			return null;
		}
		if (suggestions.length === 0) return null;

		const items = suggestions.map((s) => ({ ...s, value: mention.wrap(s.value) }));

		return {
			items,
			prefix: pathMatch,
		};
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] ?? "";
		const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
		const afterCursor = currentLine.slice(cursorCol);
		const isQuotedPrefix = prefix.startsWith('"') || prefix.startsWith('/"');
		const hasLeadingQuoteAfterCursor = afterCursor.startsWith('"');
		const hasTrailingQuoteInItem = item.value.endsWith('"');
		const adjustedAfterCursor =
			isQuotedPrefix && hasTrailingQuoteInItem && hasLeadingQuoteAfterCursor ? afterCursor.slice(1) : afterCursor;

		const isOperatorCommand = prefix.startsWith(":") && beforePrefix.trim() === "";
		if (isOperatorCommand) {
			const newLine = `${beforePrefix}:${item.value} ${adjustedAfterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 2, // +2 for ":" and space
			};
		}

		const textBeforeCursor = currentLine.slice(0, cursorCol);
		if (textBeforeCursor.trimStart().startsWith(":") && textBeforeCursor.includes(" ")) {
			const newLine = beforePrefix + item.value + adjustedAfterCursor;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			const isDirectory = item.label.endsWith("/");
			const hasTrailingQuote = item.value.endsWith('"');
			const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + cursorOffset,
			};
		}

		const newLine = beforePrefix + item.value + adjustedAfterCursor;
		const newLines = [...lines];
		newLines[cursorLine] = newLine;

		const isDirectory = item.label.endsWith("/");
		const hasTrailingQuote = item.value.endsWith('"');
		const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;

		return {
			lines: newLines,
			cursorLine,
			cursorCol: beforePrefix.length + cursorOffset,
		};
	}

	private extractPathPrefix(text: string, forceExtract: boolean = false): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const pathPrefix = lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1);

		// For forced extraction (Tab key), always return something
		if (forceExtract) {
			return pathPrefix;
		}

		if (pathPrefix.includes("/") || pathPrefix.startsWith(".") || pathPrefix.startsWith("~/")) {
			return pathPrefix;
		}

		// Return empty string only after a space (not for completely empty text)
		// Empty text should not trigger file suggestions - that's for forced Tab completion
		if (pathPrefix === "" && text.endsWith(" ")) {
			return pathPrefix;
		}

		return null;
	}

	// Expand home directory (~/) to actual home path
	private expandHomePath(path: string): string {
		if (path.startsWith("~/")) {
			const expandedPath = join(homedir(), path.slice(2));
			// Preserve trailing slash if original path had one
			return path.endsWith("/") && !expandedPath.endsWith("/") ? `${expandedPath}/` : expandedPath;
		} else if (path === "~") {
			return homedir();
		}
		return path;
	}

	private resolveScopedFuzzyQuery(rawQuery: string): { baseDir: string; query: string; displayBase: string } | null {
		const normalizedQuery = toDisplayPath(rawQuery);
		const slashIndex = normalizedQuery.lastIndexOf("/");
		if (slashIndex === -1) {
			return null;
		}

		const displayBase = normalizedQuery.slice(0, slashIndex + 1);
		const query = normalizedQuery.slice(slashIndex + 1);

		let baseDir: string;
		if (displayBase.startsWith("~/")) {
			baseDir = this.expandHomePath(displayBase);
		} else if (displayBase.startsWith("/")) {
			baseDir = displayBase;
		} else {
			baseDir = join(this.basePath, displayBase);
		}

		try {
			if (!statSync(baseDir).isDirectory()) {
				return null;
			}
		} catch {
			return null;
		}

		return { baseDir, query, displayBase };
	}

	private scopedPathForDisplay(displayBase: string, relativePath: string): string {
		const normalizedRelativePath = toDisplayPath(relativePath);
		if (displayBase === "/") {
			return `/${normalizedRelativePath}`;
		}
		return `${toDisplayPath(displayBase)}${normalizedRelativePath}`;
	}

	// Get file/directory suggestions for a given path prefix
	private getFileSuggestions(prefix: string): AutocompleteItem[] {
		try {
			let searchDir: string;
			let searchPrefix: string;
			const { rawQuery: rawPrefix, isQuoted: isQuotedPrefix } = parsePathPrefix(prefix);
			let expandedPrefix = rawPrefix;

			// Handle home directory expansion
			if (expandedPrefix.startsWith("~")) {
				expandedPrefix = this.expandHomePath(expandedPrefix);
			}

			const isRootPrefix =
				rawPrefix === "" ||
				rawPrefix === "./" ||
				rawPrefix === "../" ||
				rawPrefix === "~" ||
				rawPrefix === "~/" ||
				rawPrefix === "/";

			if (isRootPrefix) {
				// Complete from specified position
				if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = expandedPrefix;
				} else {
					searchDir = join(this.basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else if (rawPrefix.endsWith("/")) {
				// If prefix ends with /, show contents of that directory
				if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = expandedPrefix;
				} else {
					searchDir = join(this.basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else {
				// Split into directory and file prefix
				const dir = dirname(expandedPrefix);
				const file = basename(expandedPrefix);
				if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = dir;
				} else {
					searchDir = join(this.basePath, dir);
				}
				searchPrefix = file;
			}

			const entries = readdirSync(searchDir, { withFileTypes: true });
			const suggestions: AutocompleteItem[] = [];

			for (const entry of entries) {
				if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) {
					continue;
				}

				let isDirectory = entry.isDirectory();
				if (!isDirectory && entry.isSymbolicLink()) {
					try {
						const fullPath = join(searchDir, entry.name);
						isDirectory = statSync(fullPath).isDirectory();
					} catch {
						// Broken symlink or permission error - treat as file
					}
				}

				let relativePath: string;
				const name = entry.name;
				const displayPrefix = rawPrefix;

				if (displayPrefix.endsWith("/")) {
					// If prefix ends with /, append entry to the prefix
					relativePath = displayPrefix + name;
				} else if (displayPrefix.includes("/") || displayPrefix.includes("\\")) {
					// Preserve ~/ format for home directory paths
					if (displayPrefix.startsWith("~/")) {
						const homeRelativeDir = displayPrefix.slice(2); // Remove ~/
						const dir = dirname(homeRelativeDir);
						relativePath = `~/${dir === "." ? name : join(dir, name)}`;
					} else if (displayPrefix.startsWith("/")) {
						// Absolute path - construct properly
						const dir = dirname(displayPrefix);
						if (dir === "/") {
							relativePath = `/${name}`;
						} else {
							relativePath = `${dir}/${name}`;
						}
					} else {
						relativePath = join(dirname(displayPrefix), name);
						// path.join normalizes away ./ prefix, preserve it
						if (displayPrefix.startsWith("./") && !relativePath.startsWith("./")) {
							relativePath = `./${relativePath}`;
						}
					}
				} else {
					// For standalone entries, preserve ~/ if original prefix was ~/
					if (displayPrefix.startsWith("~")) {
						relativePath = `~/${name}`;
					} else {
						relativePath = name;
					}
				}

				relativePath = toDisplayPath(relativePath);
				const pathValue = isDirectory ? `${relativePath}/` : relativePath;
				const value = buildCompletionValue(pathValue, { isQuotedPrefix });

				suggestions.push({
					value,
					label: name + (isDirectory ? "/" : ""),
				});
			}

			// Sort directories first, then alphabetically
			suggestions.sort((a, b) => {
				const aIsDir = a.value.endsWith("/");
				const bIsDir = b.value.endsWith("/");
				if (aIsDir && !bIsDir) return -1;
				if (!aIsDir && bIsDir) return 1;
				return a.label.localeCompare(b.label);
			});

			return suggestions;
		} catch (_e) {
			// Directory doesn't exist or not accessible
			return [];
		}
	}

	// Score an entry against the query (higher = better match)
	// isDirectory adds bonus to prioritize folders
	private scoreEntry(filePath: string, query: string, isDirectory: boolean): number {
		const lowerFileName = basename(filePath).toLowerCase();
		const lowerQuery = query.toLowerCase();
		const lowerPath = filePath.toLowerCase();

		// First matching rule wins (rules ordered by descending weight).
		const matchedRule = MATCH_SCORE_RULES.find((r) => r.test(lowerFileName, lowerPath, lowerQuery));
		const score = matchedRule?.weight ?? 0;

		// Directories get a bonus to appear first
		return isDirectory && score > 0 ? score + DIRECTORY_BONUS : score;
	}

	// Fuzzy file search using fd (fast, respects .gitignore)
	private async getFuzzyFileSuggestions(
		query: string,
		options: { isQuotedPrefix: boolean; signal: AbortSignal },
	): Promise<AutocompleteItem[]> {
		if (!this.fdPath || options.signal.aborted) {
			return [];
		}

		try {
			const scopedQuery = this.resolveScopedFuzzyQuery(query);
			const fdBaseDir = scopedQuery?.baseDir ?? this.basePath;
			const fdQuery = scopedQuery?.query ?? query;
			const entries = await walkDirectoryWithFd(fdBaseDir, this.fdPath, fdQuery, 100, options.signal);

			const scoredEntries = entries
				.map((entry) => ({
					...entry,
					score: fdQuery ? this.scoreEntry(entry.path, fdQuery, entry.isDirectory) : 1,
				}))
				.filter((entry) => entry.score > 0);

			scoredEntries.sort((a, b) => b.score - a.score);
			const topEntries = scoredEntries.slice(0, 20);

			const suggestions: AutocompleteItem[] = [];
			for (const { path: entryPath, isDirectory } of topEntries) {
				const pathWithoutSlash = isDirectory ? entryPath.slice(0, -1) : entryPath;
				const displayPath = scopedQuery
					? this.scopedPathForDisplay(scopedQuery.displayBase, pathWithoutSlash)
					: pathWithoutSlash;
				const entryName = basename(pathWithoutSlash);
				const completionPath = isDirectory ? `${displayPath}/` : displayPath;
				const value = buildCompletionValue(completionPath, { isQuotedPrefix: options.isQuotedPrefix });

				suggestions.push({
					value,
					label: entryName + (isDirectory ? "/" : ""),
					description: displayPath,
				});
			}

			return suggestions;
		} catch {
			return [];
		}
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const currentLine = lines[cursorLine] ?? "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Don't trigger if we're typing an operator command at the start of the line
		if (textBeforeCursor.trim().startsWith(":") && !textBeforeCursor.trim().includes(" ")) {
			return false;
		}

		return true;
	}
}
