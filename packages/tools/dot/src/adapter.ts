/**
 * Alef tool façade over the remote Dot game server.
 */
import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import { defineAdapter, typedAction } from "@dpopsuev/alef-kernel/adapter";
import type { Bus } from "@dpopsuev/alef-kernel/bus";
import { withDisplay } from "@dpopsuev/alef-kernel/payload";
import { z } from "zod";
import { createDotGameClient, type DotGameClient } from "./client.js";
import type { DotSnapshot } from "./world.js";

const OBSERVE_TOOL = {
	name: "dot.observe",
	description: "Observe the current dot position and whether it is still inside the circle.",
	inputSchema: z.object({}),
};

const MOVE_TOOL = {
	name: "dot.move",
	description: "Apply a control impulse (dx, dy), then one random drift tick. Keep the dot inside the circle.",
	inputSchema: z.object({
		dx: z.number().min(-2).max(2).describe("Control impulse on x, clamped to ±2"),
		dy: z.number().min(-2).max(2).describe("Control impulse on y, clamped to ±2"),
	}),
};

const RESET_TOOL = {
	name: "world.reset",
	description: "Reset the world to the origin with an optional PRNG seed (test harness).",
	inputSchema: z.object({
		seed: z.number().optional().describe("Optional PRNG seed"),
	}),
};

/** Options for createDotAdapter. */
export interface DotAdapterOptions {
	readonly baseUrl: string;
	readonly client?: DotGameClient;
}

/** Build snapshot fields without display (caller wraps withDisplay). */
function snapshotFields(snap: DotSnapshot): Record<string, unknown> {
	const observedAt = Date.now();
	return {
		...snap,
		conditions: [
			{ domain: "dot", key: "x", value: snap.x, confidence: 1, observedAt },
			{ domain: "dot", key: "y", value: snap.y, confidence: 1, observedAt },
			{ domain: "dot", key: "inside", value: snap.inside, confidence: 1, observedAt },
		],
	};
}

/** Plain-text pill for the TUI. */
function displayText(snap: DotSnapshot): string {
	return `dot (${snap.x.toFixed(2)},${snap.y.toFixed(2)}) dist=${snap.dist.toFixed(2)} ${snap.status}`;
}

/** Alef tool façade over the remote Dot game server. */
export function createDotAdapter(opts: DotAdapterOptions): Adapter {
	const client = opts.client ?? createDotGameClient(opts.baseUrl);
	let mountedBus: Bus | null = null;
	let lastStatus: string | undefined;

	/** Publish started/ended notifications when status changes. */
	function emitLifecycle(snap: DotSnapshot): void {
		if (snap.status === lastStatus) return;
		const previous = lastStatus;
		lastStatus = snap.status;
		if (snap.status === "game_over") {
			mountedBus?.notification.publish({
				type: "dot.ended",
				payload: { reason: "game_over", ...snap },
				correlationId: "",
			});
		} else if (previous === undefined && snap.tick === 0) {
			mountedBus?.notification.publish({
				type: "dot.started",
				payload: { ...snap },
				correlationId: "",
			});
		}
	}

	return defineAdapter(
		"dot",
		{
			command: {
				"dot.observe": typedAction(OBSERVE_TOOL, async () => {
					const snap = await client.observe();
					emitLifecycle(snap);
					return withDisplay(snapshotFields(snap), { text: displayText(snap), mimeType: "text/plain" });
				}),
				"dot.move": typedAction(MOVE_TOOL, async (ctx) => {
					const snap = await client.move(ctx.payload.dx, ctx.payload.dy);
					emitLifecycle(snap);
					return withDisplay(snapshotFields(snap), { text: displayText(snap), mimeType: "text/plain" });
				}),
				"world.reset": typedAction(RESET_TOOL, async (ctx) => {
					lastStatus = undefined;
					const snap = await client.reset(ctx.payload.seed);
					emitLifecycle(snap);
					return withDisplay(snapshotFields(snap), { text: displayText(snap), mimeType: "text/plain" });
				}),
			},
		},
		{
			description: "Dot-in-circle game client — remote plant for reconcile episodes.",
			directives: [
				"Goal: keep the dot inside the circle.",
				"Call dot.observe to read position (x, y, inside).",
				"Call dot.move with dx, dy toward the origin to counteract drift.",
				"If status is game_over, the episode has failed.",
			],
			onMount: (bus) => {
				mountedBus = bus;
			},
			onUnmount: () => {
				mountedBus = null;
			},
		},
	);
}

/**
 * Materializer entry — base URL from DOT_GAME_URL (public config).
 */
export function createAdapter(_opts: { cwd: string }): Adapter {
	const baseUrl = process.env.DOT_GAME_URL;
	if (!baseUrl || baseUrl.trim().length === 0) {
		throw new Error("createAdapter(dot): set DOT_GAME_URL to the game server base URL (e.g. http://127.0.0.1:PORT)");
	}
	return createDotAdapter({ baseUrl });
}
