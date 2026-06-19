import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BaseOrganOptions, ContextAssemblyHandler } from "@dpopsuev/alef-kernel";
import { defineOrgan, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import type { ISessionStore } from "@dpopsuev/alef-session";
import { assembleTurns, DEFAULT_CONTEXT_WINDOW_POLICY, turnsToMessages } from "@dpopsuev/alef-session";
import { z } from "zod";

export interface MemoryOrganOptions extends BaseOrganOptions {
	compactionThreshold?: number;
	recentGuarantee?: number;
	sessionStore?: () => ISessionStore | undefined;
	contextWindow?: number;
}

type RawMsg = { role: string; content: unknown };

export function createMemoryOrgan(opts: MemoryOrganOptions = {}) {
	const recentGuarantee = opts.recentGuarantee ?? 4;
	const contextWindow = opts.contextWindow ?? 128_000;

	function scratchpadPath(): string | null {
		const session = opts.sessionStore?.();
		if (!session) return null;
		return join(dirname(session.path), "state.md");
	}

	const organBase = defineOrgan(
		"memory",
		{
			motor: {
				"scratchpad.write": typedAction(
					{
						name: "scratchpad.write",
						description:
							"Write to the session scratchpad (state.md). Persists intent, current state, desired state, and plan across turns.",
						inputSchema: z.object({
							content: z.string().min(1).describe("Full scratchpad content (overwrites previous)"),
						}),
					},
					async (ctx) => {
						const path = scratchpadPath();
						if (!path)
							return withDisplay(
								{ error: "no session" },
								{ text: "No session store available", mimeType: "text/plain" },
							);
						writeFileSync(path, ctx.payload.content, "utf-8");
						return withDisplay(
							{ written: true, chars: ctx.payload.content.length },
							{ text: `Scratchpad updated (${ctx.payload.content.length} chars)`, mimeType: "text/plain" },
						);
					},
				),
				"scratchpad.read": typedAction(
					{
						name: "scratchpad.read",
						description: "Read the current session scratchpad (state.md).",
						inputSchema: z.object({}),
					},
					async () => {
						const path = scratchpadPath();
						if (!path) return withDisplay({ content: "" }, { text: "(no session)", mimeType: "text/plain" });
						const session = opts.sessionStore?.();
						const content = session ? (readStateFile(session) ?? "") : "";
						return withDisplay({ content }, { text: content || "(empty scratchpad)", mimeType: "text/plain" });
					},
				),
			},
		},
		{
			description: "Five-level memory pyramid + scratchpad for reconciliation state.",
			directives: [
				"Use scratchpad.write to persist your intent, current state, desired state, and plan.",
				"The scratchpad is injected into your context automatically on each turn.",
			],
			sources: [{ name: "session-store", kind: "file" }],
			...opts,
		},
	);

	function readStateFile(session: ISessionStore): string | null {
		try {
			const statePath = join(dirname(session.path), "state.md");
			return readFileSync(statePath, "utf-8").trim() || null;
		} catch {
			return null;
		}
	}

	function phaseStageHandler(): ContextAssemblyHandler {
		return async ({ messages, turn: _turn }) => {
			const msgs = messages as unknown as RawMsg[];
			if (!msgs.length) return {};

			const session = opts.sessionStore?.();
			if (!session) return {};

			const systemMsg = msgs.find((m) => m.role === "system");
			const currentUserMsg = msgs.at(-1);
			if (!currentUserMsg) return {};

			const [turns, hitCounts] = await Promise.all([session.turns(), session.hitCounts()]);
			if (turns.length === 0) return {};

			const query = typeof currentUserMsg.content === "string" ? currentUserMsg.content : "";
			const selected = assembleTurns(turns, {
				query,
				contextWindow,
				hitCounts,
				policy: { recentGuarantee },
			});
			if (selected.length === 0) return {};

			const budgetTotal = Math.floor(contextWindow * 0.7);
			const maxSingleTurnCost = Math.floor(budgetTotal * DEFAULT_CONTEXT_WINDOW_POLICY.maxSingleTurnFraction);
			const budgetUsed = selected.reduce((n, t) => n + Math.min(t.tokenCost, maxSingleTurnCost), 0);
			void session.append({
				bus: "internal",
				type: "window.assembled",
				correlationId: `wa-${Date.now()}`,
				payload: {
					includedTurnIds: selected.map((t) => t.id),
					queryTokens: query
						.toLowerCase()
						.split(/\W+/)
						.filter((t) => t.length > 2),
					budgetUsed,
					budgetTotal,
				},
				timestamp: Date.now(),
			});

			const projected = turnsToMessages(selected);
			if (projected.length === 0) return {};

			// Guard: if turnsToMessages already ends with the current user message
			// (because the in-flight turn was recorded in the session store before
			// the phase pipeline runs), do not append it again — consecutive
			// same-role messages are rejected by the API.
			const projectedMsgs = projected as unknown as RawMsg[];
			const projectedLast = projectedMsgs.at(-1);
			const alreadyAppended =
				projectedLast?.role === currentUserMsg.role && projectedLast?.content === currentUserMsg.content;

			const scratchpad = readStateFile(session);
			const scratchpadMsg: RawMsg[] = scratchpad
				? [{ role: "user", content: `[Scratchpad — prior state]\n${scratchpad}` }]
				: [];

			const assembled: RawMsg[] = [
				...(systemMsg ? [systemMsg] : []),
				...scratchpadMsg,
				...projectedMsgs,
				...(!alreadyAppended && currentUserMsg.role === "user" ? [currentUserMsg] : []),
			];

			return { messages: assembled as unknown as typeof messages };
		};
	}

	const handler = phaseStageHandler();

	return {
		...organBase,
		contributions: { "context.assemble": handler },
		phaseStage(): ContextAssemblyHandler {
			return handler;
		},
	};
}
