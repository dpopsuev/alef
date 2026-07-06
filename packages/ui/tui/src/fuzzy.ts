/**
 * Search strategies — built-in matching algorithms for TUI pickers and filters.
 *
 * Strategies (fzf-compatible syntax):
 *   fuzzy        default   subsequence match, chars in order not contiguous
 *   'exact       quoted    contiguous substring match
 *   ^prefix      caret     starts-with match
 *   suffix$      dollar    ends-with match
 *   !inverse     bang      exclude items matching the rest
 *   !^invPrefix  combo     exclude items starting with...
 *   !suffix$     combo     exclude items ending with...
 *
 * Multi-token: space-separated tokens are AND-ed (all must match).
 * OR: pipe-separated alternatives within a token group.
 *
 * Extended syntax parsed by parseSearchTokens().
 * Individual strategies exposed for programmatic use.
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/**
 *
 */
export interface FuzzyMatch {
	matches: boolean;
	score: number;
}

/**
 *
 */
export type MatchStrategy = (query: string, text: string) => FuzzyMatch;

// ---------------------------------------------------------------------------
// Strategy: Subsequence (fzf default)
// ---------------------------------------------------------------------------

/**
 *
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch {
	const queryLower = query.toLowerCase();
	const textLower = text.toLowerCase();

	const matchQuery = (normalizedQuery: string): FuzzyMatch => {
		if (normalizedQuery.length === 0) return { matches: true, score: 0 };
		if (normalizedQuery.length > textLower.length) return { matches: false, score: 0 };

		let queryIndex = 0;
		let score = 0;
		let lastMatchIndex = -1;
		let consecutiveMatches = 0;

		for (let i = 0; i < textLower.length && queryIndex < normalizedQuery.length; i++) {
			if (textLower[i] === normalizedQuery[queryIndex]) {
				const isWordBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1]);

				if (lastMatchIndex === i - 1) {
					consecutiveMatches++;
					score -= consecutiveMatches * 5;
				} else {
					consecutiveMatches = 0;
					if (lastMatchIndex >= 0) score += (i - lastMatchIndex - 1) * 2;
				}

				if (isWordBoundary) score -= 10;
				score += i * 0.1;
				lastMatchIndex = i;
				queryIndex++;
			}
		}

		if (queryIndex < normalizedQuery.length) return { matches: false, score: 0 };
		if (normalizedQuery === textLower) score -= 100;
		return { matches: true, score };
	};

	const primaryMatch = matchQuery(queryLower);
	if (primaryMatch.matches) return primaryMatch;

	const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
	const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
	const swappedQuery = alphaNumericMatch
		? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
		: numericAlphaMatch
			? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
			: "";

	if (!swappedQuery) return primaryMatch;

	const swappedMatch = matchQuery(swappedQuery);
	if (!swappedMatch.matches) return primaryMatch;
	return { matches: true, score: swappedMatch.score + 5 };
}

// ---------------------------------------------------------------------------
// Strategy: Exact (contiguous substring)
// ---------------------------------------------------------------------------

/**
 *
 */
export function exactMatch(query: string, text: string): FuzzyMatch {
	const idx = text.toLowerCase().indexOf(query.toLowerCase());
	if (idx === -1) return { matches: false, score: 0 };
	return { matches: true, score: idx + query.length };
}

// ---------------------------------------------------------------------------
// Strategy: Prefix
// ---------------------------------------------------------------------------

/**
 *
 */
export function prefixMatch(query: string, text: string): FuzzyMatch {
	const matches = text.toLowerCase().startsWith(query.toLowerCase());
	return { matches, score: matches ? -query.length : 0 };
}

// ---------------------------------------------------------------------------
// Strategy: Suffix
// ---------------------------------------------------------------------------

/**
 *
 */
export function suffixMatch(query: string, text: string): FuzzyMatch {
	const matches = text.toLowerCase().endsWith(query.toLowerCase());
	return { matches, score: matches ? -query.length : 0 };
}

// ---------------------------------------------------------------------------
// Strategy: Regex
// ---------------------------------------------------------------------------

/**
 *
 */
export function regexMatch(pattern: string, text: string): FuzzyMatch {
	try {
		const re = new RegExp(pattern, "i");
		const m = re.exec(text);
		if (!m) return { matches: false, score: 0 };
		return { matches: true, score: m.index + m[0].length };
	} catch {
		return { matches: false, score: 0 };
	}
}

// ---------------------------------------------------------------------------
// Extended search token parser (fzf syntax)
// ---------------------------------------------------------------------------

/**
 *
 */
export interface SearchToken {
	strategy: "fuzzy" | "exact" | "prefix" | "suffix" | "regex";
	query: string;
	inverse: boolean;
}

/**
 *
 */
export function parseSearchTokens(input: string): SearchToken[][] {
	const trimmed = input.trim();
	if (!trimmed) return [];

	const orGroups = trimmed.split("|").map((g) => g.trim());
	return orGroups.map((group) => {
		const tokens = group.split(/\s+/).filter((t) => t.length > 0);
		return tokens.map(parseOneToken);
	});
}

/**
 *
 */
function parseOneToken(raw: string): SearchToken {
	let inverse = false;
	let s = raw;

	if (s.startsWith("!")) {
		inverse = true;
		s = s.slice(1);
	}

	if (s.startsWith("'")) {
		return { strategy: "exact", query: s.slice(1), inverse };
	}
	if (s.startsWith("^")) {
		return { strategy: "prefix", query: s.slice(1), inverse };
	}
	if (s.endsWith("$") && s.length > 1) {
		return { strategy: "suffix", query: s.slice(0, -1), inverse };
	}
	if (s.startsWith("/") && s.endsWith("/") && s.length > 2) {
		return { strategy: "regex", query: s.slice(1, -1), inverse };
	}
	return { strategy: "fuzzy", query: s, inverse };
}

const STRATEGY_MAP: Record<SearchToken["strategy"], MatchStrategy> = {
	fuzzy: fuzzyMatch,
	exact: exactMatch,
	prefix: prefixMatch,
	suffix: suffixMatch,
	regex: regexMatch,
};

/**
 *
 */
function evaluateToken(token: SearchToken, text: string): FuzzyMatch {
	const result = STRATEGY_MAP[token.strategy](token.query, text);
	if (token.inverse) {
		return { matches: !result.matches, score: result.matches ? 0 : -1 };
	}
	return result;
}

// ---------------------------------------------------------------------------
// Extended search filter (fzf-style)
// ---------------------------------------------------------------------------

/**
 *
 */
export function extendedFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	const orGroups = parseSearchTokens(query);
	if (orGroups.length === 0) return items;

	const results: { item: T; totalScore: number }[] = [];

	for (const item of items) {
		const text = getText(item);
		let bestGroupScore: number | null = null;

		for (const tokens of orGroups) {
			let groupScore = 0;
			let allMatch = true;

			for (const token of tokens) {
				const result = evaluateToken(token, text);
				if (result.matches) {
					groupScore += result.score;
				} else {
					allMatch = false;
					break;
				}
			}

			if (allMatch && (bestGroupScore === null || groupScore < bestGroupScore)) {
				bestGroupScore = groupScore;
			}
		}

		if (bestGroupScore !== null) {
			results.push({ item, totalScore: bestGroupScore });
		}
	}

	results.sort((a, b) => a.totalScore - b.totalScore);
	return results.map((r) => r.item);
}

// ---------------------------------------------------------------------------
// Simple multi-token fuzzy filter (backward compatible)
// ---------------------------------------------------------------------------

/**
 *
 */
export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	if (!query.trim()) return items;

	const tokens = query
		.trim()
		.split(/\s+/)
		.filter((t) => t.length > 0);

	if (tokens.length === 0) return items;

	const results: { item: T; totalScore: number }[] = [];

	for (const item of items) {
		const text = getText(item);
		let totalScore = 0;
		let allMatch = true;

		for (const token of tokens) {
			const match = fuzzyMatch(token, text);
			if (match.matches) {
				totalScore += match.score;
			} else {
				allMatch = false;
				break;
			}
		}

		if (allMatch) {
			results.push({ item, totalScore });
		}
	}

	results.sort((a, b) => a.totalScore - b.totalScore);
	return results.map((r) => r.item);
}
