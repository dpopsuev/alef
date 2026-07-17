import { parseAtAddress } from "@dpopsuev/alef-agent/identity/routes";
import { InputPatternRegistry } from "@dpopsuev/alef-agent/input-patterns";
import { isCompacting } from "@dpopsuev/alef-session/compaction";
import type { Session } from "@dpopsuev/alef-session/contracts";
import type { ImageAttachment } from "@dpopsuev/alef-tui";
import type { InteractiveOptions } from "../boot/interactive.js";
import type { TuiEvent } from "./events.js";
import type { TuiHandlerContext } from "./handlers.js";
import { handleColonCommand, handleSlashCommand } from "./handlers.js";
import type { TokenFooterHandle, TuiWriter } from "./state.js";

/**
 * Configuration for message submission.
 */
const SEND_TIMEOUT_MS = 3_600_000;

/** Messages submitted while idle+compacting — flushed after compact ends. */
const compactionPark: string[] = [];

/** Park a user message that arrived during idle compaction. */
export function parkCompactionMessage(text: string): void {
	compactionPark.push(text);
}

/** Current idle-compaction park depth (for pending-queue UI). */
export function compactionParkLength(): number {
	return compactionPark.length;
}

/**
 * Deliver messages parked during idle compaction.
 * Call when context.compacting transitions to active=false.
 */
export function flushCompactionPark(session: Pick<Session, "receive" | "send">): string[] {
	const pending = compactionPark.splice(0, compactionPark.length);
	for (const text of pending) {
		if (typeof session.receive === "function") {
			session.receive(text, { delivery: "followUp" });
		} else if (typeof session.send === "function") {
			void session.send(text);
		}
	}
	return pending;
}

/** Dependencies and callbacks for the editor's onSubmit handler. */
export interface SubmitConfig {
	actorRoutes: InteractiveOptions["actorRoutes"];
	session: Session;
	writer: TuiWriter;
	addToHistory: (text: string) => void;
	addHistoryEntry: (text: string) => void;
	clearEditor: () => void;
	dispatch: (event: TuiEvent) => void;
	ctx: () => TuiHandlerContext;
	onThinkingStop: () => void;
	/** True while a turn is in flight — mid-turn prompts are queued, not scrollbacked yet. */
	isTurnActive?: () => boolean;
	forums?: {
		switchTo(name: string): unknown;
		list(): Promise<readonly string[]> | readonly string[];
		getActive(): string;
	};
}

/**
 * Convert image attachments to text description.
 * Note: Full image support requires extending Session.send() to accept content arrays.
 * For now, we append a text description of the attachments.
 */
function attachmentsToText(attachments: ImageAttachment[]): string {
	if (attachments.length === 0) return "";
	const descriptions = attachments.map((att) => {
		const dims = att.width && att.height ? ` ${att.width}x${att.height}` : "";
		const size = (att.size / 1024 / 1024).toFixed(2);
		return `[Image: ${att.fileName}${dims} ${size}MB]`;
	});
	return `\n\n${descriptions.join("\n")}`;
}

/**
 * Handle message submission from the editor.
 * Returns a function that can be used as the editor's onSubmit handler.
 */
export function createSubmitHandler(config: SubmitConfig) {
	const {
		actorRoutes,
		session,
		writer,
		addToHistory,
		addHistoryEntry,
		clearEditor,
		dispatch,
		ctx,
		onThinkingStop,
		isTurnActive,
	} = config;

	const inputPatterns = new InputPatternRegistry();

	inputPatterns.register({
		name: "colon-command",
		leader: ":",
		detection: "beginning",
		description: "Colon commands dispatched to command registry",
		handle: (text) => {
			handleColonCommand(text, ctx());
			return true;
		},
	});

	inputPatterns.register({
		name: "command",
		leader: "/",
		detection: "beginning",
		description: "Slash commands (aliases to colon commands)",
		handle: (text) => {
			handleSlashCommand(text, ctx());
			return true;
		},
	});

	inputPatterns.register({
		name: "message",
		leader: "@",
		detection: "beginning",
		description: "Route message or switch forum",
		handle: async (text) => {
			const trimmed = text.trim();

			// Bare "@" → list available discussion topics
			if (trimmed === "@" && config.forums) {
				const chans = await config.forums.list();
				const active = config.forums.getActive();
				writer.addNotice(`Topics: ${chans.map((c) => `@${c}${c === active ? " (active)" : ""}`).join(", ")}`);
				return true;
			}

			// Bare "@name" (no message) → switch active topic
			const bareMatch = /^@([\w.]+)$/.exec(trimmed);
			if (bareMatch && config.forums) {
				const nextTopic = bareMatch[1]!;
				config.forums.switchTo(nextTopic);
				writer.addNotice(`Switched to topic @${nextTopic}`);
				return true;
			}

			if (!actorRoutes) return false;
			const parsed = parseAtAddress(text);
			if (!parsed) return false;

			if (actorRoutes.isHumanAddress(parsed.address)) {
				writer.addNotice("You can't message yourself.");
				return true;
			}

			const route = actorRoutes.resolve(parsed.address);
			if (!route) {
				const known = actorRoutes
					.addresses()
					.map((a) => `@${a}`)
					.join(", ");
				writer.addNotice(`Unknown actor: @${parsed.address}. Known: ${known || "(none)"}`);
				return true;
			}

			await executeMessage({
				text,
				message: parsed.message,
				executor: async () => {
					await route(parsed.message, SEND_TIMEOUT_MS);
				},
				session,
				writer,
				addToHistory,
				addHistoryEntry,
				clearEditor,
				dispatch,
				onThinkingStop,
				isTurnActive,
			});
			return true;
		},
	});

	return async (
		rawText: string,
		attachments: ImageAttachment[] = [],
		opts?: { delivery?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> => {
		const text = rawText.trim();
		if (!text) return;

		if (await inputPatterns.dispatch(text)) return;

		// Execute regular message
		const sendFn = session.send;
		const messageWithAttachments = text + attachmentsToText(attachments);
		await executeMessage({
			text,
			message: messageWithAttachments,
			executor: sendFn
				? async () => {
						await sendFn(messageWithAttachments, SEND_TIMEOUT_MS);
					}
				: undefined,
			session,
			writer,
			addToHistory,
			addHistoryEntry,
			clearEditor,
			dispatch,
			onThinkingStop,
			isTurnActive,
			delivery: opts?.delivery,
		});
	};
}

/**
 * Internal: Execute a message (either direct or routed).
 */
interface ExecuteMessageConfig {
	text: string;
	message: string;
	executor?: () => Promise<void>;
	session: Session;
	writer: TuiWriter;
	addToHistory: (text: string) => void;
	addHistoryEntry: (text: string) => void;
	clearEditor: () => void;
	dispatch: (event: TuiEvent) => void;
	onThinkingStop: () => void;
	isTurnActive?: () => boolean;
	delivery?: "steer" | "followUp" | "nextTurn";
}

/** Send a message through the executor, managing turn lifecycle and abort handling. */
async function executeMessage(config: ExecuteMessageConfig): Promise<void> {
	const {
		text,
		message,
		executor,
		session,
		writer,
		addToHistory,
		addHistoryEntry,
		clearEditor,
		dispatch,
		onThinkingStop,
		isTurnActive,
		delivery,
	} = config;

	addToHistory(text);
	clearEditor();
	addHistoryEntry(text);

	const turnActive = Boolean(isTurnActive?.());
	const compacting = isCompacting();

	// Idle + compacting: do not call receive (reasoner would pump a racing turn and drop).
	// Park locally; flushCompactionPark runs when context.compacting active=false.
	if (compacting && !turnActive) {
		parkCompactionMessage(message);
		dispatch({
			type: "message-queued",
			queueLength: compactionParkLength(),
			text: message,
			mode: "followUp",
		});
		return;
	}

	// Mid-turn (including overflow compact): enqueue via reasoner; it emits message-queued.
	if (turnActive) {
		if (session.receive) {
			session.receive(message, { delivery: delivery ?? "steer" });
		} else if (executor) {
			void executor();
		}
		return;
	}

	writer.addUserMessage(text);
	dispatch({ type: "turn.start", timestamp: Date.now() });

	let aborted = false;
	const controller = new AbortController();
	session.setTurnController(controller);
	dispatch({
		type: "abort.set",
		fn: () => {
			aborted = true;
			controller.abort();
		},
	});

	try {
		if (executor) await executor();
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- aborted is mutated by abort callback during await
		if (!aborted) {
			const tokenFooter: TokenFooterHandle = writer.addTokenFooter();
			dispatch({ type: "turn.complete", tokenFooter });
		}
	} catch (e) {
		dispatch({ type: "turn.error", error: e, aborted });
	} finally {
		dispatch({ type: "abort.clear" });
		session.setTurnController(undefined);
		onThinkingStop();
	}
}
