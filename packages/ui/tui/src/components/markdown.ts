import { Marked, type Token, Tokenizer, type Tokens } from "marked";
import type { Component } from "../component.js";
import { getCapabilities, hyperlink, isImageLine } from "../terminal-image.js";
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.js";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

/**
 *
 */
class StrictStrikethroughTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2];
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

const markdownParser = new Marked();
markdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
	/** Foreground color function */
	color?: (text: string) => string;
	/** Background color function */
	bgColor?: (text: string) => string;
	/** Bold text */
	bold?: boolean;
	/** Italic text */
	italic?: boolean;
	/** Strikethrough text */
	strikethrough?: boolean;
	/** Underline text */
	underline?: boolean;
}

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
	/** Prefix applied to each rendered code block line (default: "  ") */
	codeBlockIndent?: string;
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

/**
 *
 */
export class Markdown implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private defaultTextStyle?: DefaultTextStyle;
	private theme: MarkdownTheme;
	private defaultStylePrefix?: string;

	// Cache for rendered output
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
		this.defaultTextStyle = defaultTextStyle;
	}

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		// Check cache
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// Calculate available width for content (subtract horizontal padding)
		const contentWidth = Math.max(1, width - this.paddingX * 2);

		// Don't render anything if there's no actual text
		if (!this.text || this.text.trim() === "") {
			const result: string[] = [];
			// Update cache
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		// Replace tabs with 3 spaces for consistent rendering
		const normalizedText = this.text.replace(/\t/g, "   ");

		// Parse markdown to HTML-like tokens
		const tokens = markdownParser.lexer(normalizedText);

		// Convert tokens to styled terminal output
		const renderedLines: string[] = [];

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			const nextType = i + 1 < tokens.length ? tokens[i + 1].type : undefined;
			const tokenLines = this.renderToken(token, contentWidth, nextType);
			renderedLines.push(...tokenLines);
		}

		// Wrap lines (NO padding, NO background yet)
		const wrappedLines: string[] = [];
		for (const line of renderedLines) {
			if (isImageLine(line)) {
				wrappedLines.push(line);
			} else {
				wrappedLines.push(...wrapTextWithAnsi(line, contentWidth));
			}
		}

		// Add margins and background to each wrapped line
		const leftMargin = " ".repeat(this.paddingX);
		const rightMargin = " ".repeat(this.paddingX);
		const bgFn = this.defaultTextStyle?.bgColor;
		const contentLines: string[] = [];

		for (const line of wrappedLines) {
			if (isImageLine(line)) {
				contentLines.push(line);
				continue;
			}

			const lineWithMargins = leftMargin + line + rightMargin;

			if (bgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
			} else {
				// No background - just pad to width
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, width - visibleLen);
				contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
			}
		}

		// Add top/bottom padding (empty lines)
		const emptyLine = " ".repeat(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
			emptyLines.push(line);
		}

		// Combine top padding, content, and bottom padding
		const result = [...emptyLines, ...contentLines, ...emptyLines];

		// Update cache
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}

	/**
	 * Apply default text style to a string.
	 * This is the base styling applied to all text content.
	 * NOTE: Background color is NOT applied here - it's applied at the padding stage
	 * to ensure it extends to the full line width.
	 */
	private applyDefaultStyle(text: string): string {
		if (!this.defaultTextStyle) {
			return text;
		}

		let styled = text;

		// Apply foreground color (NOT background - that's applied at padding stage)
		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		// Apply text decorations using this.theme
		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		return styled;
	}

	private getDefaultStylePrefix(): string {
		if (!this.defaultTextStyle) {
			return "";
		}

		if (this.defaultStylePrefix !== undefined) {
			return this.defaultStylePrefix;
		}

		const sentinel = "\u0000";
		let styled = sentinel;

		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		const sentinelIndex = styled.indexOf(sentinel);
		this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.defaultStylePrefix;
	}

	private getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	private getDefaultInlineStyleContext(): InlineStyleContext {
		return {
			applyText: (text: string) => this.applyDefaultStyle(text),
			stylePrefix: this.getDefaultStylePrefix(),
		};
	}

	private renderToken(
		token: Token,
		width: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];

		const renderHeading = (): void => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dispatch table guarantees token.type === "heading"
			const heading = token as Tokens.Heading;
			const headingLevel = heading.depth;
			const headingPrefix = `${"#".repeat(headingLevel)} `;

			// Build a heading-specific style context so inline tokens (codespan, bold, etc.)
			// restore heading styling after their own ANSI resets instead of falling back to
			// the default text style.
			let headingStyleFn: (text: string) => string;
			if (headingLevel === 1) {
				headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(this.theme.underline(text)));
			} else {
				headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(text));
			}

			const headingStyleContext: InlineStyleContext = {
				applyText: headingStyleFn,
				stylePrefix: this.getStylePrefix(headingStyleFn),
			};

			const headingText = this.renderInlineTokens(heading.tokens, headingStyleContext);
			const styledHeading = headingLevel >= 3 ? headingStyleFn(headingPrefix) + headingText : headingText;
			lines.push(styledHeading);
			if (nextTokenType && nextTokenType !== "space") {
				lines.push(""); // Add spacing after headings (unless space token follows)
			}
		};

		const renderParagraph = (): void => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dispatch table guarantees token.type === "paragraph"
			const paragraph = token as Tokens.Paragraph;
			const paragraphText = this.renderInlineTokens(paragraph.tokens, styleContext);
			lines.push(paragraphText);
			// Don't add spacing if next token is space or list
			if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
				lines.push("");
			}
		};

		const renderText = (): void => {
			lines.push(this.renderInlineTokens([token], styleContext));
		};

		const renderCode = (): void => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dispatch table guarantees token.type === "code"
			const codeToken = token as Tokens.Code;
			const indent = this.theme.codeBlockIndent ?? "  ";
			lines.push(this.theme.codeBlockBorder(`\`\`\`${codeToken.lang ?? ""}`));
			if (this.theme.highlightCode) {
				const highlightedLines = this.theme.highlightCode(codeToken.text, codeToken.lang);
				for (const hlLine of highlightedLines) {
					lines.push(`${indent}${hlLine}`);
				}
			} else {
				// Split code by newlines and style each line
				const codeLines = codeToken.text.split("\n");
				for (const codeLine of codeLines) {
					lines.push(`${indent}${this.theme.codeBlock(codeLine)}`);
				}
			}
			lines.push(this.theme.codeBlockBorder("```"));
			if (nextTokenType && nextTokenType !== "space") {
				lines.push(""); // Add spacing after code blocks (unless space token follows)
			}
		};

		const renderList = (): void => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- mdast node type checked by parent case
			const listLines = this.renderList(token as Tokens.List, 0, width, styleContext);
			lines.push(...listLines);
			// Don't add spacing after lists if a space token follows
			// (the space token will handle it)
		};

		const renderTable = (): void => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- mdast node type checked by parent case
			const tableLines = this.renderTable(token as Tokens.Table, width, nextTokenType, styleContext);
			lines.push(...tableLines);
		};

		const renderBlockquote = (): void => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dispatch table guarantees token.type === "blockquote"
			const blockquote = token as Tokens.Blockquote;
			const quoteStyle = (text: string) => this.theme.quote(this.theme.italic(text));
			const quoteStylePrefix = this.getStylePrefix(quoteStyle);
			const applyQuoteStyle = (line: string): string => {
				if (!quoteStylePrefix) {
					return quoteStyle(line);
				}
				const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
				return quoteStyle(lineWithReappliedStyle);
			};

			// Calculate available width for quote content (subtract border "│ " = 2 chars)
			const quoteContentWidth = Math.max(1, width - 2);

			// Blockquotes contain block-level tokens (paragraph, list, code, etc.), so render
			// children with renderToken() instead of renderInlineTokens().
			// Default message style should not apply inside blockquotes.
			const quoteInlineStyleContext: InlineStyleContext = {
				applyText: (text: string) => text,
				stylePrefix: quoteStylePrefix,
			};
			const quoteTokens = blockquote.tokens;
			const renderedQuoteLines: string[] = [];
			for (let i = 0; i < quoteTokens.length; i++) {
				const quoteToken = quoteTokens[i];
				const nextType = i + 1 < quoteTokens.length ? quoteTokens[i + 1].type : undefined;
				renderedQuoteLines.push(
					...this.renderToken(quoteToken, quoteContentWidth, nextType, quoteInlineStyleContext),
				);
			}

			// Avoid rendering an extra empty quote line before the outer blockquote spacing.
			while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
				renderedQuoteLines.pop();
			}

			for (const quoteLine of renderedQuoteLines) {
				const styledLine = applyQuoteStyle(quoteLine);
				const wrappedLines = wrapTextWithAnsi(styledLine, quoteContentWidth);
				for (const wrappedLine of wrappedLines) {
					lines.push(this.theme.quoteBorder("│ ") + wrappedLine);
				}
			}
			if (nextTokenType && nextTokenType !== "space") {
				lines.push(""); // Add spacing after blockquotes (unless space token follows)
			}
		};

		const renderHr = (): void => {
			lines.push(this.theme.hr("─".repeat(Math.min(width, 80))));
			if (nextTokenType && nextTokenType !== "space") {
				lines.push(""); // Add spacing after horizontal rules (unless space token follows)
			}
		};

		const renderHtml = (): void => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dispatch table guarantees token.type === "html"
			const html = token as Tokens.HTML;
			// Render HTML as plain text (escaped for terminal)
			lines.push(this.applyDefaultStyle(html.raw.trim()));
		};

		const renderSpace = (): void => {
			// Space tokens represent blank lines in markdown
			lines.push("");
		};

		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const renderDefault = (): void => {
			// Handle any other token types as plain text
			if ("text" in token && typeof token.text === "string") {
				lines.push(token.text);
			}
		};

		const tokenRenderers: Record<string, () => void> = {
			heading: renderHeading,
			paragraph: renderParagraph,
			text: renderText,
			code: renderCode,
			list: renderList,
			table: renderTable,
			blockquote: renderBlockquote,
			hr: renderHr,
			html: renderHtml,
			space: renderSpace,
		};

		const renderer = tokenRenderers[token.type];
		renderer();

		return lines;
	}

	private renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
		let result = "";
		const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;
		const applyTextWithNewlines = (text: string): string => {
			const segments: string[] = text.split("\n");
			return segments.map((segment: string) => applyText(segment)).join("\n");
		};

		const renderInlineText = (tk: Token): void => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dispatch table guarantees tk.type === "text"
			const textToken = tk as Tokens.Text;
			// Text tokens in list items can have nested tokens for inline formatting
			if (textToken.tokens && textToken.tokens.length > 0) {
				result += this.renderInlineTokens(textToken.tokens, resolvedStyleContext);
			} else {
				result += applyTextWithNewlines(textToken.text);
			}
		};

		const renderInlineParagraph = (tk: Token): void => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dispatch table guarantees tk.type === "paragraph"
			const paragraph = tk as Tokens.Paragraph;
			// Paragraph tokens contain nested inline tokens
			result += this.renderInlineTokens(paragraph.tokens, resolvedStyleContext);
		};

		const renderInlineStrong = (tk: Token): void => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dispatch table guarantees tk.type === "strong"
			const strong = tk as Tokens.Strong;
			const boldContent = this.renderInlineTokens(strong.tokens, resolvedStyleContext);
			result += this.theme.bold(boldContent) + stylePrefix;
		};

		const renderInlineEm = (tk: Token): void => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dispatch table guarantees tk.type === "em"
			const em = tk as Tokens.Em;
			const italicContent = this.renderInlineTokens(em.tokens, resolvedStyleContext);
			result += this.theme.italic(italicContent) + stylePrefix;
		};

		const renderInlineCodespan = (tk: Token): void => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dispatch table guarantees tk.type === "codespan"
			const codespan = tk as Tokens.Codespan;
			result += this.theme.code(codespan.text) + stylePrefix;
		};

		const renderInlineLink = (tk: Token): void => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dispatch table guarantees tk.type === "link"
			const link = tk as Tokens.Link;
			const linkText = this.renderInlineTokens(link.tokens, resolvedStyleContext);
			const styledLink = this.theme.link(this.theme.underline(linkText));
			if (getCapabilities().hyperlinks) {
				// OSC 8: render as a clickable hyperlink. The URL is not printed inline,
				// so we always show only the link text regardless of whether it matches href.
				result += hyperlink(styledLink, link.href) + stylePrefix;
			} else {
				// Fallback: print URL in parentheses when text differs from href.
				// Compare raw token.text (not styled) against href for the equality check.
				// For mailto: links strip the prefix (autolinked emails use text="foo@bar.com"
				// but href="mailto:foo@bar.com").
				const hrefForComparison = link.href.startsWith("mailto:") ? link.href.slice(7) : link.href;
				if (link.text === link.href || link.text === hrefForComparison) {
					result += styledLink + stylePrefix;
				} else {
					result += styledLink + this.theme.linkUrl(` (${link.href})`) + stylePrefix;
				}
			}
		};

		const renderInlineBr = (): void => {
			result += "\n";
		};

		const renderInlineDel = (tk: Token): void => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dispatch table guarantees tk.type === "del"
			const del = tk as Tokens.Del;
			const delContent = this.renderInlineTokens(del.tokens, resolvedStyleContext);
			result += this.theme.strikethrough(delContent) + stylePrefix;
		};

		const renderInlineHtml = (tk: Token): void => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dispatch table guarantees tk.type === "html"
			const html = tk as Tokens.HTML;
			// Render inline HTML as plain text
			result += applyTextWithNewlines(html.raw);
		};

		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const renderInlineDefault = (tk: Token): void => {
			// Handle any other inline token types as plain text
			if ("text" in tk && typeof tk.text === "string") {
				result += applyTextWithNewlines(tk.text);
			}
		};

		const inlineRenderers: Record<string, (tk: Token) => void> = {
			text: renderInlineText,
			paragraph: renderInlineParagraph,
			strong: renderInlineStrong,
			em: renderInlineEm,
			codespan: renderInlineCodespan,
			link: renderInlineLink,
			br: renderInlineBr,
			del: renderInlineDel,
			html: renderInlineHtml,
		};

		for (const token of tokens) {
			const renderer = inlineRenderers[token.type];
			renderer(token);
		}

		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}

		return result;
	}

	/**
	 * Render a list with proper nesting support
	 */
	private renderList(token: Tokens.List, depth: number, width: number, styleContext?: InlineStyleContext): string[] {
		const lines: string[] = [];
		const indent = "    ".repeat(depth);
		// Use the list's start property (defaults to 1 for ordered lists)
		const startNumber = typeof token.start === "number" ? token.start : 1;

		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i];
			const bullet = token.ordered ? `${startNumber + i}. ` : "- ";
			const firstPrefix = indent + this.theme.listBullet(bullet);
			const continuationPrefix = indent + " ".repeat(visibleWidth(bullet));
			const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
			let renderedAnyLine = false;

			for (const itemToken of item.tokens) {
				if (itemToken.type === "list") {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- mdast node type checked by parent case
					lines.push(...this.renderList(itemToken as Tokens.List, depth + 1, width, styleContext));
					renderedAnyLine = true;
					continue;
				}

				const itemLines = this.renderToken(itemToken, itemWidth, undefined, styleContext);
				for (const line of itemLines) {
					for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
						const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
						lines.push(linePrefix + wrappedLine);
						renderedAnyLine = true;
					}
				}
			}

			if (!renderedAnyLine) {
				lines.push(firstPrefix);
			}
		}

		return lines;
	}

	/**
	 * Get the visible width of the longest word in a string.
	 */
	private getLongestWordWidth(text: string, maxWidth?: number): number {
		const words = text.split(/\s+/).filter((word) => word.length > 0);
		let longest = 0;
		for (const word of words) {
			longest = Math.max(longest, visibleWidth(word));
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	/**
	 * Wrap a table cell to fit into a column.
	 *
	 * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
	 * consistently with the rest of the renderer.
	 */
	private wrapCellText(text: string, maxWidth: number): string[] {
		return wrapTextWithAnsi(text, Math.max(1, maxWidth));
	}

	/**
	 * Render a table with width-aware cell wrapping.
	 * Cells that don't fit are wrapped to multiple lines.
	 */
	private renderTable(
		token: Tokens.Table,
		availableWidth: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];
		const numCols = token.header.length;

		if (numCols === 0) {
			return lines;
		}

		// Calculate border overhead: "│ " + (n-1) * " │ " + " │"
		// = 2 + (n-1) * 3 + 2 = 3n + 1
		const borderOverhead = 3 * numCols + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < numCols) {
			// Too narrow to render a stable table. Fall back to raw markdown.
			const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
			if (nextTokenType && nextTokenType !== "space") {
				fallbackLines.push("");
			}
			return fallbackLines;
		}

		const maxUnbrokenWordWidth = 30;

		// Calculate natural column widths (what each column needs without constraints)
		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		for (let i = 0; i < numCols; i++) {
			const headerText = this.renderInlineTokens(token.header[i].tokens, styleContext);
			naturalWidths[i] = visibleWidth(headerText);
			minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		for (const row of token.rows) {
			for (let i = 0; i < row.length; i++) {
				const cellText = this.renderInlineTokens(row[i].tokens, styleContext);
				naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
				minWordWidths[i] = Math.max(
					minWordWidths[i] || 1,
					this.getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}

		let minColumnWidths = minWordWidths;
		let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

		if (minCellsWidth > availableForCells) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Array.fill(1) produces number[] but TS infers any[]
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
				const growth = minWordWidths.map((width) => {
					const weight = Math.max(0, width - 1);
					return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				});

				for (let i = 0; i < numCols; i++) {
					minColumnWidths[i] += growth[i] ?? 0;
				}

				const allocated = growth.reduce((total, width) => total + width, 0);
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					minColumnWidths[i]++;
					leftover--;
				}
			}

			minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
		}

		// Calculate column widths that fit within available width
		const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
		let columnWidths: number[];

		if (totalNaturalWidth <= availableWidth) {
			// Everything fits naturally
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
		} else {
			// Need to shrink columns to fit
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				return total + Math.max(0, width - minColumnWidths[index]);
			}, 0);
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = minColumnWidths.map((minWidth, index) => {
				const naturalWidth = naturalWidths[index];
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				let grow = 0;
				if (totalGrowPotential > 0) {
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				return minWidth + grow;
			});

			// Adjust for rounding errors - distribute remaining space
			const allocated = columnWidths.reduce((a, b) => a + b, 0);
			let remaining = availableForCells - allocated;
			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i++) {
					if (columnWidths[i] < naturalWidths[i]) {
						columnWidths[i]++;
						remaining--;
						grew = true;
					}
				}
				if (!grew) {
					break;
				}
			}
		}

		// Render top border
		const topBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`┌─${topBorderCells.join("─┬─")}─┐`);

		// Render header with wrapping
		const headerCellLines: string[][] = token.header.map((cell, i) => {
			const text = this.renderInlineTokens(cell.tokens, styleContext);
			return this.wrapCellText(text, columnWidths[i]);
		});
		const headerLineCount = Math.max(...headerCellLines.map((c) => c.length));

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			const rowParts = headerCellLines.map((cellLines, colIdx) => {
				const text = cellLines[lineIdx] || "";
				const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				return this.theme.bold(padded);
			});
			lines.push(`│ ${rowParts.join(" │ ")} │`);
		}

		// Render separator
		const separatorCells = columnWidths.map((w) => "─".repeat(w));
		const separatorLine = `├─${separatorCells.join("─┼─")}─┤`;
		lines.push(separatorLine);

		// Render rows with wrapping
		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			const row = token.rows[rowIndex];
			const rowCellLines: string[][] = row.map((cell, i) => {
				const text = this.renderInlineTokens(cell.tokens, styleContext);
				return this.wrapCellText(text, columnWidths[i]);
			});
			const rowLineCount = Math.max(...rowCellLines.map((c) => c.length));

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				const rowParts = rowCellLines.map((cellLines, colIdx) => {
					const text = cellLines[lineIdx] || "";
					return text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				});
				lines.push(`│ ${rowParts.join(" │ ")} │`);
			}

			if (rowIndex < token.rows.length - 1) {
				lines.push(separatorLine);
			}
		}

		// Render bottom border
		const bottomBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`└─${bottomBorderCells.join("─┴─")}─┘`);

		if (nextTokenType && nextTokenType !== "space") {
			lines.push(""); // Add spacing after table
		}
		return lines;
	}
}
