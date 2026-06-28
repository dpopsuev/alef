import { parseAtAddress } from "@dpopsuev/alef-agent/identity/routes";
import { InputPatternRegistry } from "@dpopsuev/alef-agent/input-patterns";
import type { Session } from "@dpopsuev/alef-session/contracts";
import type { InteractiveOptions } from "./interactive.js";
import type { TuiHandlerContext } from "./tui-commands.js";
import { handleColonCommand, handleSlashCommand } from "./tui-commands.js";
import type { TuiEvent } from "./tui-dispatch.js";
import type { TokenFooterHandle, TuiWriter } from "./tui-state.js";

/**
 * Configuration for message submission.
 */
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
	forums?: { switchTo(name: string): unknown; list(): string[]; active: string };
}

/**
 * Handle message submission from the editor.
 * Returns a function that can be used as the editor's onSubmit handler.
 */
export function createSubmitHandler(config: SubmitConfig) {
	const { actorRoutes, session, writer, addToHistory, addHistoryEntry, clearEditor, dispatch, ctx, onThinkingStop } =
		config;

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

			// Bare "@" → list available forums
			if (trimmed === "@" && config.forums) {
				const chans = config.forums.list();
				const active = config.forums.active;
				writer.addNotice(`Channels: ${chans.map((c) => `@${c}${c === active ? " (active)" : ""}`).join(", ")}`);
				return true;
			}

			// Bare "@name" (no message) → switch forum
			const bareMatch = /^@([\w.]+)$/.exec(trimmed);
			if (bareMatch && config.forums) {
				config.forums.switchTo(bareMatch[1]);
				writer.addNotice(`Switched to @${bareMatch[1]}`);
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
					await route(parsed.message, 3_600_000);
				},
				session,
				writer,
				addToHistory,
				addHistoryEntry,
				clearEditor,
				dispatch,
				onThinkingStop,
			});
			return true;
		},
	});

	return async (rawText: string): Promise<void> => {
		const text = rawText.trim();
		if (!text) return;

		if (await inputPatterns.dispatch(text)) return;

		// Execute regular message
		const sendFn = session.send;
		await executeMessage({
			text,
			message: text,
			executor: sendFn
				? async () => {
						await sendFn(text, 3_600_000);
					}
				: undefined,
			session,
			writer,
			addToHistory,
			addHistoryEntry,
			clearEditor,
			dispatch,
			onThinkingStop,
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
}

async function executeMessage(config: ExecuteMessageConfig): Promise<void> {
	const { text, executor, session, writer, addToHistory, addHistoryEntry, clearEditor, dispatch, onThinkingStop } =
		config;

	addToHistory(text);
	clearEditor();
	addHistoryEntry(text);
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
