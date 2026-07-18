/**
 * SessionHandle — thin runtime state wrapper around an assembled agent.
 *
 * Zero adapter imports. Zero assembly code. Owns only:
 *   - turn count and max-turns enforcement
 *   - model and thinking state switches
 *   - abort controller reference
 *   - observer fan-out
 *   - send/receive/subscribe/dispose delegation
 *
 * Created by the assembly factory (local-session.ts) after all adapters are loaded.
 */

import type { Directives } from "@dpopsuev/alef-agent/directives";
import { rememberLastModel } from "@dpopsuev/alef-agent/model";
import { completeSimple } from "@dpopsuev/alef-ai/stream";
import type { Api, Model, ThinkingLevel } from "@dpopsuev/alef-ai/types";
import { loadAdapterFromPath } from "@dpopsuev/alef-blueprint/materializer";
import type { Agent } from "@dpopsuev/alef-engine/agent";
import type { AgentController } from "@dpopsuev/alef-engine/controller";
import type { DiscussionRef, DiscussionState, DiscussionSubscription } from "@dpopsuev/alef-kernel/execution";
import type { AgentEvent, DirectiveView, Session, SessionState } from "@dpopsuev/alef-session/contracts";
import { createLlmSummarizer } from "@dpopsuev/alef-session/summarizer";
import type { DiscourseBackend } from "@dpopsuev/alef-tool-discourse";
import type { Logger } from "pino";
import type { Args } from "./args.js";

/** Extract text content from a discourse payload when present. */
function contentText(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const text: unknown = Reflect.get(value, "text");
	return typeof text === "string" ? text : undefined;
}

/** Dependencies injected into SessionHandle at construction time. */
export interface SessionHandleComponents {
	state: SessionState;
	model: Model<Api>;
	thinkingState: { level: ThinkingLevel | undefined };
	controller: AgentController;
	agent: Agent;
	directives: Directives;
	args: Args;
	log: Logger;
	observers: Set<(event: AgentEvent) => void>;
	modelFactory: (id: string) => Model<Api>;
	discussion: DiscussionState;
	discourseBackend: DiscourseBackend;
	humanAddress: string;
	agentAddress: string;
	/** Keep the LLM adapter's getModel() in sync when the session model changes. */
	onModelChange?: (model: Model<Api>) => void;
}

/** Thin runtime state wrapper that delegates send/receive/subscribe to the assembled agent. */
export class SessionHandle implements Session {
	readonly state: SessionState;

	_currentModel: Model<Api>;
	_thinkingState: { level: ThinkingLevel | undefined };
	_llmController: AbortController | undefined;
	private _turnCount = 0;
	private readonly _observers: Set<(event: AgentEvent) => void>;
	private readonly _modelFactory: (id: string) => Model<Api>;
	private _discussionState: DiscussionState;
	private readonly _discourseBackend: DiscourseBackend;
	private readonly _humanAddress: string;
	private readonly _agentAddress: string;
	private readonly _onModelChange?: (model: Model<Api>) => void;

	private readonly _agent: Agent;
	private readonly _directives: Directives;
	private readonly _controller: AgentController;
	private readonly _args: Args;
	private readonly _log: Logger;

	constructor({
		state,
		model,
		thinkingState,
		controller,
		agent,
		directives,
		args,
		log,
		observers,
		modelFactory,
		discussion,
		discourseBackend,
		humanAddress,
		agentAddress,
		onModelChange,
	}: SessionHandleComponents) {
		this.state = state;
		this._currentModel = model;
		this._thinkingState = thinkingState;
		this._controller = controller;
		this._agent = agent;
		this._directives = directives;
		this._args = args;
		this._log = log;
		this._observers = observers;
		this._modelFactory = modelFactory;
		this._discussionState = discussion;
		this._discourseBackend = discourseBackend;
		this._humanAddress = humanAddress;
		this._agentAddress = agentAddress;
		this._onModelChange = onModelChange;
	}

	getModel(): string {
		return this._currentModel.id;
	}

	/** Full model object for adapters that need contextWindow / provider after a switch. */
	getModelObject(): Model<Api> {
		return this._currentModel;
	}

	setModel(id: string): void {
		this._currentModel = this._modelFactory(id);
		this.state.modelId = this._currentModel.id;
		this.state.contextWindow = this._currentModel.contextWindow;
		const supportsThinking = this._currentModel.reasoning && !this._currentModel.id.includes("haiku");
		if (!supportsThinking) this._thinkingState.level = undefined;
		else this._thinkingState.level ??= "medium";
		rememberLastModel(this._currentModel.id);
		this._onModelChange?.(this._currentModel);
		this._notifyStateChanged();
	}

	getThinking(): string {
		return this._thinkingState.level ?? "off";
	}

	setThinking(level: string): void {
		const thinkingLevels: readonly string[] = ["minimal", "low", "medium", "high", "xhigh"];
		this._thinkingState.level =
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated by includes() check above
			level !== "off" && thinkingLevels.includes(level) ? (level as ThinkingLevel) : undefined;
		this._notifyStateChanged();
	}

	private _notifyStateChanged(): void {
		const event: AgentEvent = {
			type: "state-changed",
			modelId: this._currentModel.id,
			thinking: this._thinkingState.level ?? "off",
			contextWindow: this._currentModel.contextWindow,
		};
		for (const obs of this._observers) obs(event);
	}

	setTurnController(ctrl: AbortController | undefined): void {
		this._llmController = ctrl;
	}

	getDiscussionState(): DiscussionState | undefined {
		return this._discussionState;
	}

	getDiscussion(): DiscussionRef | undefined {
		return this._discussionState.active;
	}

	setDiscussion(next: Partial<DiscussionRef>): void {
		const active = { ...this._discussionState.active, ...next };
		const home = this._sameDiscussion(this._discussionState.home, active)
			? { ...this._discussionState.home, ...next }
			: this._discussionState.home;
		const subscriptions = this._upsertSubscription(this._discussionState.subscriptions, active, {
			mode: "participate",
		});
		this._setDiscussionState({ ...this._discussionState, home, active, subscriptions });
	}

	subscribeDiscussion(
		discussion: DiscussionRef,
		opts?: { mode?: DiscussionSubscription["mode"]; leaseMs?: number },
	): void {
		const subscriptions = this._upsertSubscription(this._discussionState.subscriptions, discussion, {
			mode: opts?.mode ?? "watch",
			leaseMs: opts?.leaseMs,
		});
		this._setDiscussionState({ ...this._discussionState, subscriptions });
	}

	unsubscribeDiscussion(discussion: Pick<DiscussionRef, "forumId" | "topicId">): boolean {
		if (this._sameDiscussion(this._discussionState.home, discussion)) return false;
		const subscriptions = this._discussionState.subscriptions.filter(
			(entry) => !this._sameDiscussion(entry.discussion, discussion),
		);
		if (subscriptions.length === this._discussionState.subscriptions.length) return false;
		const active = this._sameDiscussion(this._discussionState.active, discussion)
			? this._discussionState.home
			: this._discussionState.active;
		this._setDiscussionState({ ...this._discussionState, active, subscriptions });
		return true;
	}

	async listDiscussionSubscriptions(): Promise<readonly DiscussionSubscription[]> {
		const subscriptions = this._pruneExpiredSubscriptions(
			this._discussionState.subscriptions,
			this._discussionState,
		).map((entry) => ({
			...entry,
			discussion: { ...entry.discussion },
		}));
		const refreshed = await Promise.all(
			subscriptions.map(async (entry) => {
				if (this._sameDiscussion(entry.discussion, this._discussionState.active)) {
					return { ...entry, unreadCount: 0 };
				}
				const unreadCount = await this._countUnreadPosts(entry);
				return { ...entry, unreadCount };
			}),
		);
		this._setDiscussionState({ ...this._discussionState, subscriptions: refreshed }, false);
		return refreshed;
	}

	private _setDiscussionState(next: DiscussionState, emit = true): void {
		this._discussionState = {
			...next,
			subscriptions: this._pruneExpiredSubscriptions(next.subscriptions, next),
		};
		process.env.ALEF_DISCUSSION_FORUM = this._discussionState.active.forumId;
		process.env.ALEF_DISCUSSION_TOPIC = this._discussionState.active.topicId;
		process.env.ALEF_DISCUSSION_HOME_TOPIC = this._discussionState.home.topicId;
		this.state.discussion = this._discussionState;
		if (!emit) return;
		const event: AgentEvent = { type: "discussion-changed", discussion: this._discussionState };
		for (const obs of this._observers) obs(event);
	}

	async listDiscussionTopics(): Promise<readonly string[]> {
		const topics = await this._discourseBackend.listThreads(this._discussionState.active.forumId);
		return topics.length > 0 ? topics : [this._discussionState.active.topicId];
	}

	async readDiscussionTopic(
		topicId = this._discussionState.active.topicId,
	): Promise<readonly { author: string; role: "user" | "assistant" | "other"; text: string; timestamp: number }[]> {
		const posts = await this._discourseBackend.readThread(this._discussionState.active.forumId, topicId);
		const knownDiscussion =
			this._discussionState.subscriptions.find((entry) => entry.discussion.topicId === topicId)?.discussion ??
			(this._sameDiscussion(this._discussionState.active, {
				forumId: this._discussionState.active.forumId,
				topicId,
			})
				? this._discussionState.active
				: { forumId: this._discussionState.active.forumId, topicId, topicTitle: topicId });
		this._markDiscussionRead(knownDiscussion, posts);
		return posts.map((post) => {
			const postText = contentText(post.content);
			const content = typeof post.content === "string" ? post.content : (postText ?? JSON.stringify(post.content));
			const role =
				post.author === this._humanAddress ? "user" : post.author === this._agentAddress ? "assistant" : "other";
			return { author: post.author, role, text: content, timestamp: post.timestamp };
		});
	}

	private _sameDiscussion(
		left: Pick<DiscussionRef, "forumId" | "topicId">,
		right: Pick<DiscussionRef, "forumId" | "topicId">,
	): boolean {
		return left.forumId === right.forumId && left.topicId === right.topicId;
	}

	private _pruneExpiredSubscriptions(
		subscriptions: readonly DiscussionSubscription[],
		state: Pick<DiscussionState, "home" | "active">,
	): DiscussionSubscription[] {
		const now = Date.now();
		return subscriptions.filter((entry) => {
			if (this._sameDiscussion(entry.discussion, state.home)) return true;
			if (this._sameDiscussion(entry.discussion, state.active)) return true;
			return !entry.leaseExpiresAt || entry.leaseExpiresAt > now;
		});
	}

	private _upsertSubscription(
		subscriptions: readonly DiscussionSubscription[],
		discussion: DiscussionRef,
		opts?: { mode?: DiscussionSubscription["mode"]; leaseMs?: number; lastReadAt?: number; unreadCount?: number },
	): DiscussionSubscription[] {
		const nextLease = opts?.leaseMs ? Date.now() + opts.leaseMs : undefined;
		const existing = subscriptions.find(
			(entry) => entry.discussion.forumId === discussion.forumId && entry.discussion.topicId === discussion.topicId,
		);
		if (existing) {
			return subscriptions.map((entry) =>
				entry === existing
					? {
							...entry,
							discussion: { ...entry.discussion, ...discussion },
							mode: opts?.mode ?? entry.mode,
							leaseExpiresAt: nextLease ?? entry.leaseExpiresAt,
							lastReadAt: opts?.lastReadAt ?? entry.lastReadAt,
							unreadCount: opts?.unreadCount ?? entry.unreadCount,
						}
					: entry,
			);
		}
		return [
			...subscriptions,
			{
				discussion,
				subscribedAt: Date.now(),
				mode: opts?.mode,
				leaseExpiresAt: nextLease,
				lastReadAt: opts?.lastReadAt,
				unreadCount: opts?.unreadCount ?? 0,
			},
		];
	}

	private _markDiscussionRead(discussion: DiscussionRef, posts: readonly { timestamp: number }[]): void {
		const lastReadAt = posts.length > 0 ? Math.max(...posts.map((post) => post.timestamp)) : Date.now();
		const subscriptions = this._upsertSubscription(this._discussionState.subscriptions, discussion, {
			mode: this._sameDiscussion(discussion, this._discussionState.active) ? "participate" : undefined,
			lastReadAt,
			unreadCount: 0,
		});
		this._setDiscussionState({ ...this._discussionState, subscriptions }, false);
	}

	private async _countUnreadPosts(entry: DiscussionSubscription): Promise<number> {
		const unread = await this._discourseBackend.readThread(
			entry.discussion.forumId,
			entry.discussion.topicId,
			entry.lastReadAt,
		);
		if (entry.mode !== "mentions-only") return unread.length;
		return unread.filter((post) => this._postMentionsActor(post.content)).length;
	}

	private _postMentionsActor(content: unknown): boolean {
		const text = typeof content === "string" ? content : (contentText(content) ?? JSON.stringify(content));
		return text.includes(this._agentAddress);
	}

	async loadAdapter(path: string): Promise<void> {
		const adapter = await loadAdapterFromPath(path, {
			cwd: this._args.cwd,
			loggerFor: (n) => this._log.child({ adapter: n }),
		});
		this._agent.load(adapter);
	}

	unloadAdapter(name: string): boolean {
		return this._agent.unload(name);
	}

	async reloadAdapter(name: string, path: string): Promise<void> {
		const adapter = await loadAdapterFromPath(path, {
			cwd: this._args.cwd,
			loggerFor: (n) => this._log.child({ adapter: n }),
		});
		this._agent.reload({ ...adapter, name });
	}

	async dispose(): Promise<void> {
		await this._agent.dispose();
	}

	send = async (text: string, timeoutMs?: number): Promise<string> => {
		if (this._args.maxTurns > 0 && this._turnCount >= this._args.maxTurns) {
			return Promise.reject(
				new Error(`Max turns reached (${this._args.maxTurns}). Start a new session to continue.`),
			);
		}
		this._turnCount++;
		const reply = await this._controller.send(text, "human", timeoutMs);
		const userPost = await this._discourseBackend.append(
			this._discussionState.active.forumId,
			this._discussionState.active.topicId,
			this._humanAddress,
			text,
		);
		const agentPost = await this._discourseBackend.append(
			this._discussionState.active.forumId,
			this._discussionState.active.topicId,
			this._agentAddress,
			reply,
		);
		this._markDiscussionRead(this._discussionState.active, [userPost, agentPost]);
		return reply;
	};

	receive(text: string, opts?: { delivery?: "steer" | "followUp" | "nextTurn" }): void {
		void Promise.resolve(
			this._discourseBackend.append(
				this._discussionState.active.forumId,
				this._discussionState.active.topicId,
				this._humanAddress,
				{
					text,
					delivery: opts?.delivery ?? "steer",
				},
			),
		).then((post) => {
			this._markDiscussionRead(this._discussionState.active, [post]);
		});
		this._controller.receive(text, "user", undefined, opts?.delivery);
	}

	cancelToolCall(callId: string, toolName: string): void {
		this._agent.publishEvent({
			type: toolName,
			correlationId: "*",
			payload: { toolCallId: callId, isFinal: true },
			isError: true,
			errorMessage: "Cancelled by user",
		});
	}

	summarizeForCompaction = createLlmSummarizer(async (input) => {
		const assistant = await completeSimple(this._currentModel, input);
		return {
			content: assistant.content.map((block) =>
				block.type === "text" ? { type: "text", text: block.text } : { type: block.type },
			),
		};
	});

	getDirective(): DirectiveView {
		const d = this._directives;
		const CONTENT_PREVIEW_MAX = 80;
		return {
			list: () =>
				d.list({ enabled: undefined }).map((b) => ({
					id: b.id,
					priority: b.priority,
					enabled: b.enabled,
					tags: b.tags,
					contentPreview: typeof b.content === "string" ? b.content.slice(0, CONTENT_PREVIEW_MAX) : undefined,
				})),
			enable: (id) => {
				d.enable(id);
			},
			disable: (id) => {
				d.disable(id);
			},
			toggle: (id) => {
				d.toggle(id);
			},
			replace: (id, content) => {
				d.replace(id, content);
			},
			add: (id, priority, content, tags) => {
				d.register({ id, priority, content, enabled: true, tags });
			},
			remove: (id) => {
				d.unregister(id);
			},
		};
	}

	subscribe(observer: (event: AgentEvent) => void): () => void {
		this._observers.add(observer);
		return () => {
			this._observers.delete(observer);
		};
	}

	get tools() {
		return this._agent.tools;
	}
	get adapters() {
		return this._agent.adapters;
	}
}
