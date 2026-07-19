/**
 * Footer layout engine -- composable elements, named containers, three-section overflow.
 *
 * Elements are atomic render units (model name, branch, context bar).
 * Containers group elements with a separator (AI[ctx, model], Repo[path, branch]).
 * Sections position containers (left, center, right) with overflow rules.
 *
 * Moving a container is a one-field change: { id: "ai", section: "right" }.
 */

import { truncateToWidth, visibleWidth } from "../utils.js";

/** Positional section in the footer. */
export type FooterSection = "left" | "center" | "right";

/** One atomic piece of footer content. */
export interface FooterElement {
	/** Stable identifier for this element. */
	id: string;
	/** Lower number = higher priority (kept when space is tight). */
	priority: number;
	/** Render the element content. Return empty string to hide. */
	render(maxWidth: number): string;
}

/** Named group of elements rendered with a separator. */
export interface FooterContainer {
	/** Stable identifier for this container (e.g. "ai", "repo", "alef"). */
	id: string;
	/** Which section this container belongs to. One-line change to move it. */
	section: FooterSection;
	/** Element IDs in display order. */
	children: string[];
	/** Separator between rendered children. Default: " · " (styled by caller). */
	separator?: string;
	/** Lower number = higher priority container (kept when section overflows). */
	priority?: number;
}

/** Overflow policy for a section. */
export interface SectionPolicy {
	/** Minimum percentage of total width this section always gets. */
	minPct: number;
	/** Maximum percentage this section can grow into. */
	maxPct: number;
}

/** Default section policies: left and right get 20-60%, center gets 0-40%. */
const DEFAULT_POLICIES: Record<FooterSection, SectionPolicy> = {
	left: { minPct: 0.15, maxPct: 0.6 },
	center: { minPct: 0, maxPct: 0.4 },
	right: { minPct: 0.15, maxPct: 0.6 },
};

/**
 * Render a container's children joined by separator, respecting maxWidth.
 * Drops lowest-priority elements first when space is tight.
 */
function renderContainer(
	container: FooterContainer,
	elements: Map<string, FooterElement>,
	sep: string,
	maxWidth: number,
): string {
	const rendered: Array<{ priority: number; text: string }> = [];
	for (const childId of container.children) {
		const el = elements.get(childId);
		if (!el) continue;
		const text = el.render(maxWidth);
		if (!text) continue;
		rendered.push({ priority: el.priority, text });
	}
	if (rendered.length === 0) return "";

	let joined = rendered.map((r) => r.text).join(sep);
	if (visibleWidth(joined) <= maxWidth) return joined;

	// Overflow: drop lowest-priority elements (highest number) until it fits
	const sorted = [...rendered].sort((a, b) => a.priority - b.priority);
	while (sorted.length > 1) {
		sorted.pop();
		joined = sorted.map((r) => r.text).join(sep);
		if (visibleWidth(joined) <= maxWidth) return joined;
	}
	return truncateToWidth(sorted[0]?.text ?? "", maxWidth, "\u2026");
}

/**
 * Render a section's containers joined by separator, respecting maxWidth.
 * Drops lowest-priority containers first when space is tight.
 */
function renderSection(
	containers: FooterContainer[],
	elements: Map<string, FooterElement>,
	sep: string,
	maxWidth: number,
): string {
	if (containers.length === 0 || maxWidth <= 0) return "";

	const rendered: Array<{ priority: number; text: string }> = [];
	for (const c of containers) {
		const csep = c.separator ?? sep;
		const text = renderContainer(c, elements, csep, maxWidth);
		if (!text) continue;
		rendered.push({ priority: c.priority ?? 50, text });
	}
	if (rendered.length === 0) return "";

	let joined = rendered.map((r) => r.text).join(sep);
	if (visibleWidth(joined) <= maxWidth) return joined;

	const sorted = [...rendered].sort((a, b) => a.priority - b.priority);
	while (sorted.length > 1) {
		sorted.pop();
		joined = sorted.map((r) => r.text).join(sep);
		if (visibleWidth(joined) <= maxWidth) return joined;
	}
	return truncateToWidth(sorted[0]?.text ?? "", maxWidth, "\u2026");
}

/**
 * Lay out three sections across the full width.
 * Left is flush-left, right is flush-right, center fills the gap.
 */
export function layoutFooter(
	containers: FooterContainer[],
	elements: Map<string, FooterElement>,
	width: number,
	separator = " \u00b7 ",
	policies: Partial<Record<FooterSection, SectionPolicy>> = {},
): string {
	const pol = { ...DEFAULT_POLICIES, ...policies };
	const bySection: Record<FooterSection, FooterContainer[]> = { left: [], center: [], right: [] };
	for (const c of containers) {
		bySection[c.section].push(c);
	}
	// Sort containers within each section by priority
	for (const section of ["left", "center", "right"] as FooterSection[]) {
		bySection[section].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
	}

	// Phase 1: render each section at its max allocation to get natural widths
	const maxLeft = Math.floor(width * pol.left.maxPct);
	const maxCenter = Math.floor(width * pol.center.maxPct);
	const maxRight = Math.floor(width * pol.right.maxPct);

	const leftText = renderSection(bySection.left, elements, separator, maxLeft);
	const centerText = renderSection(bySection.center, elements, separator, maxCenter);
	const rightText = renderSection(bySection.right, elements, separator, maxRight);

	const leftW = visibleWidth(leftText);
	const centerW = visibleWidth(centerText);
	const rightW = visibleWidth(rightText);

	// Phase 2: position sections
	if (!centerText) {
		// Two-section layout: left flush-left, right flush-right
		const gap = width - leftW - rightW;
		if (gap >= 2) {
			return leftText + " ".repeat(gap) + rightText;
		}
		// Overflow: re-render with tighter widths
		const half = Math.floor(width / 2);
		const tightLeft = renderSection(bySection.left, elements, separator, half - 1);
		const tightRight = renderSection(bySection.right, elements, separator, half - 1);
		const tl = visibleWidth(tightLeft);
		const tr = visibleWidth(tightRight);
		const tgap = width - tl - tr;
		if (tgap >= 2) return tightLeft + " ".repeat(tgap) + tightRight;
		return truncateToWidth(tightLeft + "  " + tightRight, width, "\u2026");
	}

	// Three-section layout: left ... center ... right
	const totalContent = leftW + centerW + rightW;
	const totalGaps = width - totalContent;
	if (totalGaps >= 4) {
		const leftGap = Math.floor(totalGaps / 2);
		const rightGap = totalGaps - leftGap;
		return leftText + " ".repeat(leftGap) + centerText + " ".repeat(rightGap) + rightText;
	}

	// Overflow: drop center, fall back to two-section
	const gap2 = width - leftW - rightW;
	if (gap2 >= 2) {
		return leftText + " ".repeat(gap2) + rightText;
	}
	return truncateToWidth(leftText + "  " + rightText, width, "\u2026");
}
