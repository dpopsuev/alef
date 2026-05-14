import { randomUUID } from "node:crypto";
import { boardPathToAddress } from "@dpopsuev/alef-agent-runtime/board";
import type { AgentSession } from "../agent-session.js";
import type {
	AgentDiscoursePort,
	ChildAgentStatus,
	ChildAgentSummary,
	KillChildAgentRequest,
	SendChildAgentMessageRequest,
	SignalChildAgentRequest,
	SpawnChildAgentRequest,
	SupervisorPort,
} from "./types.js";

interface ManagedChildAgent {
	summary: ChildAgentSummary;
	session: AgentSession;
	unsubscribe: () => void;
}

function cloneSummary(summary: ChildAgentSummary): ChildAgentSummary {
	return structuredClone(summary);
}

function extractMessageText(message: AgentSession["messages"][number]): string | undefined {
	if (message.role === "assistant") {
		const text = message.content
			.filter((content): content is { type: "text"; text: string } => content.type === "text")
			.map((content) => content.text)
			.join("");
		return text.trim() || undefined;
	}

	if (message.role === "user" || message.role === "toolResult") {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((content): content is { type: "text"; text: string } => content.type === "text")
						.map((content) => content.text)
						.join("");
		return text.trim() || undefined;
	}

	if (message.role === "custom") {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((content): content is { type: "text"; text: string } => content.type === "text")
						.map((content) => content.text)
						.join("");
		return text.trim() || undefined;
	}

	return undefined;
}

function toDiscourseScope(message: AgentSession["messages"][number]): "dialog" | "monolog" | "system" | undefined {
	switch (message.role) {
		case "assistant":
		case "user":
			return "dialog";
		case "custom":
			return "monolog";
		case "toolResult":
		case "bashExecution":
			return "system";
		default:
			return undefined;
	}
}

export class SupervisorManager implements SupervisorPort {
	private readonly children = new Map<string, ManagedChildAgent>();

	constructor(
		private readonly createSession: (request: SpawnChildAgentRequest) => Promise<AgentSession>,
		private readonly discourse: AgentDiscoursePort,
		// monolog port is structurally compatible with AgentDiscoursePort; accept but unify into discourse
		_monolog?: AgentDiscoursePort,
	) {}

	private syncTopicState(child: ManagedChildAgent, status: ChildAgentStatus, summary?: string): void {
		if (!child.summary.topicId) {
			return;
		}

		this.discourse.updateTopic({
			topicId: child.summary.topicId,
			status:
				status === "running"
					? "running"
					: status === "archived"
						? "resolved"
						: child.summary.topicId
							? "assigned"
							: undefined,
			lifecycle: status,
			summary: summary ?? child.summary.latestSummary,
			assignedAgentId: child.summary.id,
			assignedBlueprint: child.summary.definition.sourcePath ?? child.summary.definition.name,
		});
	}

	private updateChildStatus(
		child: ManagedChildAgent,
		status: ChildAgentStatus,
		options: {
			lastError?: string;
			latestSummary?: string;
		} = {},
	): void {
		child.summary = {
			...child.summary,
			status,
			updatedAt: Date.now(),
			lastError: options.lastError ?? child.summary.lastError,
			latestSummary: options.latestSummary ?? child.summary.latestSummary,
		};
		this.discourse.updateRuntime({
			runtimeId: child.summary.id,
			status,
			lastError: child.summary.lastError,
			latestSummary: child.summary.latestSummary,
			discourseAddress: child.summary.discourseAddress,
			topicId: child.summary.topicId,
			threadId: child.summary.threadId,
			claimId: child.summary.claimId,
		});
		this.syncTopicState(child, status, child.summary.latestSummary);
	}

	private getManagedChild(agentId: string): ManagedChildAgent {
		const child = this.children.get(agentId);
		if (!child) {
			throw new Error(`Unknown child agent: ${agentId}`);
		}
		return child;
	}

	private findReusableChild(request: SpawnChildAgentRequest): ManagedChildAgent | undefined {
		if (!request.topicId) {
			return undefined;
		}
		for (const child of this.children.values()) {
			if (child.summary.topicId !== request.topicId) {
				continue;
			}
			if (child.summary.status === "archived" || child.summary.status === "error") {
				continue;
			}
			const existingSource = child.summary.definition.sourcePath ?? child.summary.definition.name;
			const requestedSource = request.definition.sourcePath ?? request.definition.name;
			if (existingSource === requestedSource) {
				return child;
			}
		}
		return undefined;
	}

	private assertCapacityAvailable(): void {
		const capacity = this.discourse.getAgentCapacity();
		if (capacity.activeRuntimeIds.length >= capacity.maxConcurrent) {
			throw new Error(
				`Agent capacity exceeded: ${capacity.activeRuntimeIds.length}/${capacity.maxConcurrent} runtimes are active.`,
			);
		}
	}

	private assertBudgetAllowsSpawn(request: SpawnChildAgentRequest): void {
		const snapshots = this.discourse.readBudgetStatus({
			discourseObjectId: request.discourseObjectId ?? request.topicId,
		});
		const blocked = snapshots.find((snapshot) => snapshot.blocked);
		if (blocked) {
			throw new Error(
				`Budget abort prevents spawning for ${blocked.scope} ${blocked.window}: ${blocked.usedTokens}/${blocked.maxTokens} tokens.`,
			);
		}
		const throttled = snapshots.find((snapshot) => snapshot.throttled);
		if (throttled) {
			throw new Error(
				`Budget throttle prevents spawning for ${throttled.scope} ${throttled.window}: ${throttled.usedTokens}/${throttled.maxTokens} tokens.`,
			);
		}
	}

	private recordDiscourseLetter(child: ManagedChildAgent, message: AgentSession["messages"][number]): void {
		if (!child.summary.threadId) {
			return;
		}

		const scope = toDiscourseScope(message);
		if (!scope) {
			return;
		}

		const body = extractMessageText(message);
		if (!body) {
			return;
		}

		this.discourse.postLetter({
			threadId: child.summary.threadId,
			scope,
			author: message.role === "user" ? "root" : child.summary.name,
			body,
			runtimeId: child.summary.id,
			metadata: {
				agentId: child.summary.id,
				role: message.role,
			},
		});

		if (message.role === "assistant" || message.role === "custom") {
			this.updateChildStatus(child, child.summary.status, { latestSummary: body });
		}
	}

	private drainManagedChild(child: ManagedChildAgent, reason?: string): void {
		this.updateChildStatus(child, "draining", { latestSummary: reason ?? child.summary.latestSummary });
		if (child.summary.threadId) {
			const threadView = this.discourse.readThread({ threadId: child.summary.threadId });
			const matchingLetters = threadView.letters.filter(
				(letter) =>
					letter.runtimeId === child.summary.id ||
					letter.metadata?.agentId === child.summary.id ||
					letter.author === child.summary.name,
			);
			const atoms = matchingLetters.map((letter, index) =>
				this.discourse.createKnowledgeAtom({
					kind: `runtime-${letter.scope}-atom`,
					title: `${child.summary.name} ${letter.scope} ${index + 1}`,
					body: letter.body,
					scope: letter.scope,
					sourceType: "letter",
					sourceId: letter.id,
					createdBy: "2sec",
					discourseObjectId: child.summary.discourseObjectId ?? child.summary.topicId,
					topicId: child.summary.topicId,
					threadId: child.summary.threadId,
					runtimeId: child.summary.id,
					summary: letter.body.slice(0, 160),
					labels: letter.labels.map((label) => ({
						key: label.key,
						value: label.value,
						source: label.source,
					})),
				}),
			);
			if (atoms.length > 0) {
				this.discourse.createKnowledgeMolecule({
					kind: "runtime-drain-molecule",
					title: `${child.summary.name} drain`,
					createdBy: "2sec",
					atomIds: atoms.map((atom) => atom.id),
					sourceIds: matchingLetters.map((letter) => letter.id),
					body: child.summary.latestSummary,
					discourseObjectId: child.summary.discourseObjectId ?? child.summary.topicId,
					topicId: child.summary.topicId,
					threadId: child.summary.threadId,
					runtimeId: child.summary.id,
					summary: reason ?? child.summary.latestSummary,
					labels: [{ key: "drained", value: "true", source: "system" }],
				});
			}
		}
		this.updateChildStatus(child, "archived", {
			latestSummary: reason ?? child.summary.latestSummary,
		});
	}

	async spawnAgent(request: SpawnChildAgentRequest): Promise<ChildAgentSummary> {
		const reusable = this.findReusableChild(request);
		if (reusable) {
			if (request.initialMessage?.trim()) {
				await reusable.session.prompt(request.initialMessage, { source: "extension" });
			}
			return cloneSummary(reusable.summary);
		}

		this.assertCapacityAvailable();
		this.assertBudgetAllowsSpawn(request);
		const runtimeId = request.runtimeId ?? randomUUID();
		const session = await this.createSession({
			...request,
			runtimeId,
			discourseObjectId: request.discourseObjectId ?? request.topicId,
		});
		const now = Date.now();
		const summary: ChildAgentSummary = {
			id: runtimeId,
			name: request.name?.trim() || request.definition.name,
			role: "child",
			status: request.initialMessage?.trim() ? "running" : "waiting",
			createdAt: now,
			updatedAt: now,
			cwd: session.cwd,
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
			definition: request.definition,
			templateId: request.templateId ?? request.contractId,
			discourseAddress: request.discourseAddress,
			claimId: request.claimId,
			contractId: request.contractId,
			topicId: request.topicId,
			threadId: request.threadId,
			discourseObjectId: request.discourseObjectId ?? request.topicId,
		};

		const managedChild: ManagedChildAgent = {
			summary,
			session,
			unsubscribe: session.subscribe((event) => {
				if (event.type === "message_end") {
					this.recordDiscourseLetter(managedChild, event.message);
					return;
				}

				if (event.type === "agent_start") {
					this.updateChildStatus(managedChild, "running");
					return;
				}

				if (event.type === "agent_end") {
					const hasError = event.messages.some((message) => {
						if (message.role !== "assistant") {
							return false;
						}
						return typeof message.errorMessage === "string" && message.errorMessage.length > 0;
					});
					this.updateChildStatus(managedChild, hasError ? "error" : "idle", {
						lastError: session.state.errorMessage,
					});
				}
			}),
		};

		this.children.set(runtimeId, managedChild);
		const registered = this.discourse.registerRuntime(summary);
		managedChild.summary = registered;
		if (request.topicId) {
			const topicAddress = this.discourse.getTopic(request.topicId)?.address;
			if (topicAddress) {
				managedChild.summary.discourseAddress = boardPathToAddress(topicAddress);
				this.discourse.updateRuntime({
					runtimeId,
					discourseAddress: managedChild.summary.discourseAddress,
				});
			}
			this.discourse.assignTopic({
				topicId: request.topicId,
				status: request.initialMessage?.trim() ? "running" : "assigned",
				assignedAgentId: runtimeId,
				assignedBlueprint: request.definition.sourcePath ?? request.definition.name,
			});
		}

		if (request.initialMessage?.trim()) {
			await session.prompt(request.initialMessage, { source: "extension" });
		}

		return cloneSummary(managedChild.summary);
	}

	listAgents(): ChildAgentSummary[] {
		return this.discourse.listRuntimes();
	}

	async signalAgent(request: SignalChildAgentRequest): Promise<ChildAgentSummary> {
		const child = this.getManagedChild(request.agentId);
		switch (request.signal) {
			case "abort":
				await child.session.abort();
				this.updateChildStatus(child, "idle", { lastError: child.session.state.errorMessage });
				break;
			case "wait":
				this.updateChildStatus(child, "waiting");
				break;
			case "sleep":
				this.updateChildStatus(child, "sleep");
				break;
			case "drain":
				await child.session.abort();
				this.drainManagedChild(child, "manual drain");
				break;
		}
		return cloneSummary(child.summary);
	}

	async killAgent(request: KillChildAgentRequest): Promise<ChildAgentSummary> {
		const child = this.getManagedChild(request.agentId);
		await child.session.abort();
		this.drainManagedChild(child, "manual stop");
		child.unsubscribe();
		child.session.dispose();
		this.children.delete(request.agentId);
		return cloneSummary(child.summary);
	}

	async sendAgentMessage(request: SendChildAgentMessageRequest): Promise<ChildAgentSummary> {
		const child = this.getManagedChild(request.agentId);
		await child.session.prompt(request.message, {
			source: "extension",
			streamingBehavior: child.session.isStreaming ? "followUp" : undefined,
		});
		this.updateChildStatus(child, child.session.isStreaming ? "running" : "idle", {
			lastError: child.session.state.errorMessage,
		});
		return cloneSummary(child.summary);
	}
}
