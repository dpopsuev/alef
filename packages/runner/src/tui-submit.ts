import { parseAtAddress } from "./identity/routes.js";
import type { InteractiveOptions } from "./interactive.js";
import type { Session } from "./session.js";
import type { TuiHandlerContext } from "./tui-commands.js";
import { handleSlashCommand } from "./tui-commands.js";
import type { TuiEvent } from "./tui-reducer.js";
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
}

/**
 * Handle message submission from the editor.
 * Returns a function that can be used as the editor's onSubmit handler.
 */
export function createSubmitHandler(config: SubmitConfig) {
	const { actorRoutes, session, writer, addToHistory, addHistoryEntry, clearEditor, dispatch, ctx, onThinkingStop } =
		config;

	return async (rawText: string): Promise<void> => {
		const text = rawText.trim();
		if (!text) return;

		// Handle slash commands
		if (text.startsWith("/")) {
			handleSlashCommand(text, ctx());
			return;
		}

		// Handle @-routing: "@address do something" → route "do something" to @address
		if (text.startsWith("@") && actorRoutes) {
			const parsed = parseAtAddress(text);
			if (parsed) {
				const route = actorRoutes.resolve(parsed.address);

				// Validate routing
				if (actorRoutes.isHumanAddress(parsed.address)) {
					writer.addNotice("You can't message yourself.");
					return;
				}

				if (!route) {
					const known = actorRoutes
						.addresses()
						.map((a) => `@${a}`)
						.join(", ");
					writer.addNotice(`Unknown actor: @${parsed.address}. Known: ${known || "(none)"}`);
					return;
				}

				// Execute routed message
				await executeMessage({
					text,
					message: parsed.message,
					executor: async () => {
						await route(parsed.message, 300_000);
					},
					session,
					writer,
					addToHistory,
					addHistoryEntry,
					clearEditor,
					dispatch,
					onThinkingStop,
				});
				return;
			}
		}

		// Execute regular message
		const sendFn = session.send;
		await executeMessage({
			text,
			message: text,
			executor: sendFn
				? async () => {
						await sendFn(text, 300_000);
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
