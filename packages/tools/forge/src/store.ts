import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { forgeDir } from "@dpopsuev/alef-kernel/xdg";

/**
 *
 */
export type PullState = "open" | "merged" | "closed";

/**
 *
 */
export type ReviewEvent = "APPROVED" | "REQUEST_CHANGES" | "COMMENT";

/**
 *
 */
export interface PullReview {
	id: number;
	author: string;
	body: string;
	event: ReviewEvent;
	createdAt: string;
}

/**
 *
 */
export interface PullRequest {
	number: number;
	title: string;
	body: string;
	author: string;
	base: string;
	head: string;
	state: PullState;
	createdAt: string;
	updatedAt: string;
	mergedAt?: string;
	mergedBy?: string;
	mergeCommit?: string;
	reviews: PullReview[];
}

/**
 *
 */
interface PullFile {
	nextNumber: number;
	nextReviewId: number;
	pulls: PullRequest[];
}

/**
 * thecrux-shaped PR sidecar store: JSON next to the working tree (not a remote forge).
 */
export class PullStore {
	private readonly path: string;

	constructor(rootDir: string) {
		this.path = join(rootDir, "pulls.json");
		mkdirSync(dirname(this.path), { recursive: true });
	}

	list(state?: PullState | "all"): PullRequest[] {
		const all = this.load().pulls.slice().sort((a, b) => b.number - a.number);
		if (!state || state === "all") return all;
		return all.filter((pull) => pull.state === state);
	}

	get(number: number): PullRequest | null {
		return this.load().pulls.find((pull) => pull.number === number) ?? null;
	}

	create(input: {
		title: string;
		body?: string;
		author: string;
		base: string;
		head: string;
	}): PullRequest {
		const data = this.load();
		const now = new Date().toISOString();
		const pull: PullRequest = {
			number: data.nextNumber,
			title: input.title.trim(),
			body: (input.body ?? "").trim(),
			author: input.author,
			base: input.base,
			head: input.head,
			state: "open",
			createdAt: now,
			updatedAt: now,
			reviews: [],
		};
		data.nextNumber += 1;
		data.pulls.push(pull);
		this.save(data);
		return pull;
	}

	review(
		number: number,
		input: { author: string; body: string; event: ReviewEvent },
	): PullRequest | null {
		const data = this.load();
		const pull = data.pulls.find((item) => item.number === number);
		if (!pull || pull.state !== "open") return null;
		const review: PullReview = {
			id: data.nextReviewId,
			author: input.author,
			body: input.body.trim(),
			event: input.event,
			createdAt: new Date().toISOString(),
		};
		data.nextReviewId += 1;
		pull.reviews.push(review);
		pull.updatedAt = review.createdAt;
		this.save(data);
		return pull;
	}

	markMerged(number: number, input: { mergedBy: string; mergeCommit?: string }): PullRequest | null {
		const data = this.load();
		const pull = data.pulls.find((item) => item.number === number);
		if (!pull || pull.state !== "open") return null;
		const now = new Date().toISOString();
		pull.state = "merged";
		pull.mergedAt = now;
		pull.mergedBy = input.mergedBy;
		pull.mergeCommit = input.mergeCommit;
		pull.updatedAt = now;
		this.save(data);
		return pull;
	}

	close(number: number): PullRequest | null {
		const data = this.load();
		const pull = data.pulls.find((item) => item.number === number);
		if (!pull || pull.state !== "open") return null;
		const now = new Date().toISOString();
		pull.state = "closed";
		pull.updatedAt = now;
		this.save(data);
		return pull;
	}

	private load(): PullFile {
		try {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- own JSON schema
			return JSON.parse(readFileSync(this.path, "utf-8")) as PullFile;
		} catch {
			return { nextNumber: 1, nextReviewId: 1, pulls: [] };
		}
	}

	private save(data: PullFile): void {
		writeFileSync(this.path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
	}
}

/**
 * Default store root: `$XDG_DATA_HOME/alef/forge/<cwd-hash>/`.
 */
export function forgeRootForCwd(cwd: string): string {
	return forgeDir(cwd);
}
