import { randomUUID } from "node:crypto";
import { InProcessNerve, type Organ, type ToolDefinition, type UserMessageEvent } from "@dpopsuev/alef-spine";

// ---------------------------------------------------------------------------
// CorpusTimeoutError
// ---------------------------------------------------------------------------

export class CorpusTimeoutError extends Error {
	constructor(text: string, timeoutMs: number) {
		super(
			`Corpus.prompt() timed out after ${timeoutMs}ms. ` +
				`Prompt: "${text.length > 60 ? `${text.slice(0, 60)}…` : text}"`,
		);
		this.name = "CorpusTimeoutError";
	}
}

// ---------------------------------------------------------------------------
// Corpus — Pub-Sub entity seam, external boundary of the agent.
//
// Responsibilities:
//  - Creates the Spine (InProcessNerve) and owns it.
//  - Loads organs: mounts them onto the Spine and collects their tool definitions.
//  - Provides prompt(): the single external entry point. Emits Sense/user_message
//    (with all loaded tools), awaits Motor/user_reply by correlationId.
//  - Provides dispose(): tears down all organ subscriptions cleanly.
//
// Corpus does NOT call organ methods directly after load().
// All execution after load() is driven by events on the Spine.
// ---------------------------------------------------------------------------

export interface CorpusOptions {
	/** Default timeout for prompt() in ms. Default: 30_000. */
	timeoutMs?: number;
}

export class Corpus {
	private readonly nerve = new InProcessNerve();
	private readonly unmounts: Array<() => void> = [];
	private readonly tools: ToolDefinition[] = [];
	private disposed = false;
	private readonly defaultTimeoutMs: number;

	constructor(options: CorpusOptions = {}) {
		this.defaultTimeoutMs = options.timeoutMs ?? 30_000;
	}

	/**
	 * Load an organ onto the Spine.
	 * The organ subscribes to bus channels during mount().
	 * Its tool definitions are collected for inclusion in all future prompts.
	 * Returns `this` for chaining.
	 */
	load(organ: Organ): this {
		if (this.disposed) throw new Error("Corpus is disposed — cannot load organs.");
		const unmount = organ.mount(this.nerve);
		this.unmounts.push(unmount);
		this.tools.push(...organ.tools);
		return this;
	}

	/**
	 * Send a text prompt into the Corpus.
	 *
	 * Emits Sense/user_message (with all loaded tool definitions) onto the Spine,
	 * then awaits Motor/user_reply with the matching correlationId.
	 * Rejects with CorpusTimeoutError if no reply arrives within timeoutMs.
	 */
	prompt(text: string, options: { timeoutMs?: number } = {}): Promise<string> {
		if (this.disposed) return Promise.reject(new Error("Corpus is disposed."));

		const correlationId = randomUUID();
		const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

		return new Promise<string>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let off: (() => void) | undefined;

			const cleanup = () => {
				off?.();
				if (timer !== undefined) clearTimeout(timer);
			};

			// Subscribe BEFORE emitting to avoid missing an immediate reply.
			off = this.nerve.motor.on("user_reply", (event) => {
				if (event.type === "user_reply" && event.correlationId === correlationId) {
					cleanup();
					resolve(event.text);
				}
			});

			timer = setTimeout(() => {
				cleanup();
				reject(new CorpusTimeoutError(text, timeoutMs));
			}, timeoutMs);

			const event: UserMessageEvent = {
				type: "user_message",
				text,
				tools: [...this.tools],
				correlationId,
				timestamp: Date.now(),
			};
			this.nerve.sense.emit(event);
		});
	}

	/**
	 * Tear down all organ subscriptions.
	 * Safe to call multiple times.
	 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const unmount of this.unmounts) {
			unmount();
		}
		this.unmounts.length = 0;
	}
}
