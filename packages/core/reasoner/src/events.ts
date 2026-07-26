import { defineEvent } from "@dpopsuev/alef-kernel/events";
import { z } from "zod";

/** Rejects loss because projections need every tool start to pair lifecycle state. */
export const ToolStarted = defineEvent({
	type: "tool.started",
	version: 1,
	payload: z.object({
		callId: z.string(),
		name: z.string(),
		args: z.record(z.string(), z.unknown()),
	}),
	overflow: "reject",
});

/** Coalesces transient progress because only the latest state is actionable. */
export const ToolProgressed = defineEvent({
	type: "tool.progressed",
	version: 1,
	payload: z
		.object({
			callId: z.string(),
			name: z.string(),
			elapsedMs: z.number(),
		})
		.passthrough(),
	overflow: "coalesce",
});

/** Rejects loss because completion closes tool lifecycle state. */
export const ToolCompleted = defineEvent({
	type: "tool.completed",
	version: 1,
	payload: z.object({
		callId: z.string(),
		name: z.string(),
		elapsedMs: z.number(),
		ok: z.boolean(),
		result: z.string(),
		display: z.string().optional(),
		displayKind: z.string().optional(),
		estimatedTokens: z.number().optional(),
	}),
	overflow: "reject",
});
