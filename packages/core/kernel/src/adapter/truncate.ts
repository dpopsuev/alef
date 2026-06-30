/**
 * Tool output truncation utilities.
 *
 * Dual limits — whichever is hit first wins: line limit or byte limit.
 * Never returns partial lines (except tail truncation edge case for single
 * lines that exceed the byte limit).
 *
 * truncateHead — keep the beginning. Use for file reads, symbol reads, web pages.
 * truncateTail — keep the end. Use for command output (errors appear at the bottom).
 * truncateLine — cap a single line. Use for grep match lines.
 *
 * Env overrides: ALEF_TOOL_MAX_LINES, ALEF_TOOL_MAX_BYTES.
 */

/** Maximum lines before truncation (overridable via ALEF_TOOL_MAX_LINES). */
export const DEFAULT_MAX_LINES = Number(process.env.ALEF_TOOL_MAX_LINES) || 2000;
/** Maximum bytes before truncation (overridable via ALEF_TOOL_MAX_BYTES). */
export const DEFAULT_MAX_BYTES = Number(process.env.ALEF_TOOL_MAX_BYTES) || 50 * 1024;
/** Maximum character length for a single grep match line. */
export const GREP_MAX_LINE_LENGTH = 500;

/** Detailed outcome of a truncation operation including counts and which limit triggered. */
export interface TruncationResult {
	content: string;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	lastLinePartial: boolean;
	firstLineExceedsLimit: boolean;
	maxLines: number;
	maxBytes: number;
}

/** Optional line and byte limits for truncation functions. */
export interface TruncationOptions {
	maxLines?: number;
	maxBytes?: number;
}

/** Format a byte count as a human-readable size string (B, KB, or MB). */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function noTruncResult(
	content: string,
	totalLines: number,
	totalBytes: number,
	maxLines: number,
	maxBytes: number,
): TruncationResult {
	return {
		content,
		truncated: false,
		truncatedBy: null,
		totalLines,
		totalBytes,
		outputLines: totalLines,
		outputBytes: totalBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/** Keep the beginning of the content, dropping trailing lines that exceed limits. */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = content.split("\n");
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return noTruncResult(content, totalLines, totalBytes, maxLines, maxBytes);
	}

	const firstLineBytes = Buffer.byteLength(lines[0] ?? "", "utf-8");
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	const out: string[] = [];
	let outBytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i] ?? "";
		const lb = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0);
		if (outBytes + lb > maxBytes) {
			truncatedBy = "bytes";
			break;
		}
		out.push(line);
		outBytes += lb;
	}
	if (out.length >= maxLines && outBytes <= maxBytes) truncatedBy = "lines";
	const outputContent = out.join("\n");
	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: out.length,
		outputBytes: Buffer.byteLength(outputContent, "utf-8"),
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/** Keep the end of the content, dropping leading lines that exceed limits. */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = content.split("\n");
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return noTruncResult(content, totalLines, totalBytes, maxLines, maxBytes);
	}

	const out: string[] = [];
	let outBytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
		const line = lines[i] ?? "";
		const lb = Buffer.byteLength(line, "utf-8") + (out.length > 0 ? 1 : 0);
		if (outBytes + lb > maxBytes) {
			truncatedBy = "bytes";
			if (out.length === 0) {
				// Single line exceeds budget — take the tail of it.
				const buf = Buffer.from(line, "utf-8");
				let start = buf.length - maxBytes;
				while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
				const partial = buf.subarray(start).toString("utf-8");
				out.unshift(partial);
				outBytes = Buffer.byteLength(partial, "utf-8");
				lastLinePartial = true;
			}
			break;
		}
		out.unshift(line);
		outBytes += lb;
	}
	if (out.length >= maxLines && outBytes <= maxBytes) truncatedBy = "lines";
	const outputContent = out.join("\n");
	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: out.length,
		outputBytes: Buffer.byteLength(outputContent, "utf-8"),
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/** Cap a single line to a maximum character length, appending a truncation marker if needed. */
export function truncateLine(line: string, maxChars = GREP_MAX_LINE_LENGTH): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) return { text: line, wasTruncated: false };
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
