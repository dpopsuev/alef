/** Normalize Forgejo/Gitea webhook payloads into Alef domain events. */

/**
 *
 */
export interface DomainEvent {
	type: "pr.opened" | "pr.updated" | "pr.reviewed";
	payload: Record<string, unknown>;
}

/**
 *
 */
export function domainEventsFromWebhook(body: unknown): DomainEvent[] {
	if (!body || typeof body !== "object") return [];
	const record = asRecord(body);
	if (!record) return [];
	const action = typeof record.action === "string" ? record.action : "";
	const pull = asRecord(record.pull_request ?? record.pullRequest);
	if (!pull) return [];

	const number = typeof pull.number === "number" ? pull.number : undefined;
	const title = typeof pull.title === "string" ? pull.title : "";
	const state = typeof pull.state === "string" ? pull.state : "";
	const repo =
		asString(asRecord(record.repository)?.full_name) ??
		asString(asRecord(asRecord(pull.base)?.repo)?.full_name) ??
		"";
	const head = asString(asRecord(pull.head)?.ref) ?? "";
	const base = asString(asRecord(pull.base)?.ref) ?? "";
	const htmlUrl = asString(pull.html_url) ?? asString(pull.url) ?? "";

	const common = {
		repo,
		number,
		title,
		state,
		head,
		base,
		htmlUrl,
		action,
	};

	if (action === "opened" || action === "reopened") {
		return [{ type: "pr.opened", payload: common }];
	}
	if (action === "synchronized" || action === "edited" || action === "labeled" || action === "unlabeled") {
		return [{ type: "pr.updated", payload: common }];
	}
	if (record.review || action === "submitted") {
		const review = asRecord(record.review);
		return [
			{
				type: "pr.reviewed",
				payload: {
					...common,
					reviewState: asString(review?.state) ?? action,
					body: asString(review?.body) ?? "",
				},
			},
		];
	}
	if (action === "closed" || action === "merged") {
		return [{ type: "pr.updated", payload: { ...common, closed: true } }];
	}
	return [{ type: "pr.updated", payload: common }];
}

/**
 *
 */
function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object") return null;
	return Object.fromEntries(Object.entries(value));
}

/**
 *
 */
function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
