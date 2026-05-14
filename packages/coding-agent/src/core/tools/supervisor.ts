import { boardPathToAddress } from "@dpopsuev/alef-agent-runtime/board";
import { StringEnum } from "@dpopsuev/alef-ai";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { resolveAgentChildDefinition } from "../platform/blueprints.js";
import { getCompiledAgentOrgan } from "../platform/organs.js";
import type {
	AgentDiscoursePort,
	AgentRole,
	BlackboardTopicSummary,
	ChildAgentSummary,
	CompiledAgentDefinition,
	DiscourseContract,
	DiscourseThreadView,
	SupervisorPort,
	SupervisorSignal,
} from "../platform/types.js";

const SupervisorSignalSchema = StringEnum(["abort", "wait", "sleep", "drain"] as const);
const SupervisorActionSchema = StringEnum([
	"createTemplate",
	"createContract",
	"approveTemplate",
	"approveContract",
	"rejectTemplate",
	"rejectContract",
	"requestStamp",
	"createTopic",
	"listTopics",
	"relocateTopic",
	"archiveTopic",
	"assignTopic",
	"claimTopic",
	"releaseClaim",
	"readThread",
	"spawnAgent",
	"listAgents",
	"signalAgent",
	"killAgent",
	"sendAgentMessage",
] as const);

export const SupervisorToolInputSchema = Type.Object({
	action: SupervisorActionSchema,
	anchor: Type.Optional(Type.String({ description: "Desired-state anchor for a new discourse template." })),
	templateId: Type.Optional(Type.String({ description: "Existing discourse template id." })),
	contractId: Type.Optional(Type.String({ description: "Existing template id (legacy alias)." })),
	topic: Type.Optional(Type.String({ description: "Topic title for template decomposition." })),
	topicId: Type.Optional(Type.String({ description: "Existing topic id." })),
	threadId: Type.Optional(Type.String({ description: "Existing thread id for drilldown." })),
	address: Type.Optional(Type.String({ description: "Discourse address such as #discourse.template.topic.thread." })),
	forumId: Type.Optional(Type.String({ description: "Forum id for relocation or creation." })),
	claimId: Type.Optional(Type.String({ description: "Existing discourse claim id." })),
	leaseMs: Type.Optional(Type.Number({ description: "Lease duration in milliseconds for claim actions." })),
	reason: Type.Optional(Type.String({ description: "Reason for relocation, claim, or rejection." })),
	labels: Type.Optional(Type.Array(Type.String({ description: "Label selectors such as forum:release." }))),
	reference: Type.Optional(
		Type.String({
			description:
				"Child agent reference. Use a named child from the current agent definition or a path to an agent.yaml file.",
		}),
	),
	name: Type.Optional(Type.String({ description: "Optional runtime name override for a spawned child agent." })),
	agentId: Type.Optional(Type.String({ description: "Previously spawned child agent id." })),
	message: Type.Optional(Type.String({ description: "Message to send to the child agent." })),
	signal: Type.Optional(SupervisorSignalSchema),
});

export type SupervisorToolInput = Static<typeof SupervisorToolInputSchema>;

export type SupervisorToolDetails =
	| { action: "createTemplate"; template: DiscourseContract }
	| { action: "createContract"; contract: DiscourseContract }
	| { action: "approveTemplate"; template: DiscourseContract }
	| { action: "approveContract"; contract: DiscourseContract }
	| { action: "rejectTemplate"; template: DiscourseContract }
	| { action: "rejectContract"; contract: DiscourseContract }
	| { action: "requestStamp"; stampId: string; templateId: string }
	| { action: "createTopic"; topic: BlackboardTopicSummary }
	| { action: "listTopics"; topics: BlackboardTopicSummary[] }
	| { action: "relocateTopic"; topic: BlackboardTopicSummary }
	| { action: "archiveTopic"; topic: BlackboardTopicSummary }
	| { action: "assignTopic"; agent: ChildAgentSummary; topic: BlackboardTopicSummary }
	| { action: "claimTopic"; claimId: string; topic: BlackboardTopicSummary }
	| { action: "releaseClaim"; claimId: string }
	| { action: "readThread"; thread: DiscourseThreadView }
	| { action: "listAgents"; agents: ChildAgentSummary[] }
	| { action: "spawnAgent"; agent: ChildAgentSummary }
	| { action: "signalAgent"; agent: ChildAgentSummary; signal: SupervisorSignal }
	| { action: "killAgent"; agent: ChildAgentSummary }
	| { action: "sendAgentMessage"; agent: ChildAgentSummary };

function requireNonEmpty(value: string | undefined, message: string): string {
	const normalized = value?.trim();
	if (!normalized) {
		throw new Error(message);
	}
	return normalized;
}

function formatAgent(agent: ChildAgentSummary): string {
	const topicSuffix = agent.topicId ? ` topic=${agent.topicId}` : "";
	const addressSuffix = agent.discourseAddress ? ` address=${agent.discourseAddress}` : "";
	return `${agent.id} (${agent.name}) status=${agent.status}${topicSuffix}${addressSuffix}`;
}

function formatAgentList(agents: ChildAgentSummary[]): string {
	if (agents.length === 0) {
		return "No child agents are currently running.";
	}

	return agents.map((agent) => `- ${formatAgent(agent)}`).join("\n");
}

function formatTopic(topic: BlackboardTopicSummary): string {
	const template = topic.template ?? topic.contract;
	const latest = topic.latestLetter ? ` latest=${JSON.stringify(topic.latestLetter.body)}` : "";
	const address = boardPathToAddress(topic.topic.address);
	return `${topic.topic.id} (${topic.topic.title}) status=${topic.topic.status} address=${address} template=${template?.id ?? "-"}${latest}`;
}

function formatTopicList(topics: BlackboardTopicSummary[]): string {
	if (topics.length === 0) {
		return "No discourse topics are currently tracked.";
	}
	return topics.map((topic) => `- ${formatTopic(topic)}`).join("\n");
}

function formatThread(thread: DiscourseThreadView): string {
	const header = `Thread ${thread.thread.id} for topic ${thread.topic.id} (${thread.topic.title}) at ${boardPathToAddress(thread.thread.address)}`;
	if (thread.letters.length === 0) {
		return `${header}\n\nNo letters recorded yet.`;
	}

	const letters = thread.letters.map((letter) => `- [${letter.scope}] ${letter.author}: ${letter.body}`).join("\n");
	return `${header}\n\n${letters}`;
}

function requireActionAllowed(action: SupervisorToolInput["action"], allowedActions: Set<string>): void {
	if (!allowedActions.has(action)) {
		throw new Error(`Supervisor action "${action}" is not enabled for this agent.`);
	}
}

export function createSupervisorToolDefinition(options: {
	manager: SupervisorPort;
	discourse: AgentDiscoursePort;
	getCurrentDefinition: () => CompiledAgentDefinition | undefined;
	cwd: string;
	role: AgentRole;
}): ToolDefinition<typeof SupervisorToolInputSchema, SupervisorToolDetails> {
	const definition = options.getCurrentDefinition();
	const allowedActions = new Set(
		getCompiledAgentOrgan(definition, "supervisor")?.actions ?? [
			"createTemplate",
			"createContract",
			"approveTemplate",
			"approveContract",
			"rejectTemplate",
			"rejectContract",
			"requestStamp",
			"createTopic",
			"listTopics",
			"relocateTopic",
			"archiveTopic",
			"assignTopic",
			"claimTopic",
			"releaseClaim",
			"readThread",
			"spawnAgent",
			"listAgents",
			"signalAgent",
			"killAgent",
			"sendAgentMessage",
		],
	);

	return {
		name: "supervisor",
		label: "Supervisor",
		description:
			"Manage discourse templates, topics, and child agents from YAML blueprints. Root-only capability for delegation and drilldown.",
		promptSnippet: "Create templates, assign topics, and control child agents defined in agent.yaml blueprints",
		promptGuidelines: [
			"Use supervisor only when the user explicitly asks for sub-agents, delegation, or parallel specialized work.",
		],
		parameters: SupervisorToolInputSchema,
		action: {
			kind: "supervisor",
			capability: "supervisor",
			availability: options.role === "root" ? "root" : "child",
			description: "Root-only child agent supervisor capability.",
		},
		prepareArguments(args: unknown): SupervisorToolInput {
			if (!args || typeof args !== "object") {
				return args as SupervisorToolInput;
			}

			const input = args as Partial<SupervisorToolInput> & {
				blueprint?: string;
				child?: string;
				agent?: string;
				contract?: string;
				template?: string;
			};

			return {
				...input,
				reference: input.reference ?? input.blueprint ?? input.child,
				agentId: input.agentId ?? input.agent,
				templateId: input.templateId ?? input.template ?? input.contractId ?? input.contract,
				contractId: input.contractId ?? input.contract,
			} as SupervisorToolInput;
		},
		async execute(_toolCallId, params) {
			requireActionAllowed(params.action, allowedActions);

			switch (params.action) {
				case "createTemplate":
				case "createContract": {
					const anchor = requireNonEmpty(params.anchor, "createContract requires `anchor`.");
					const template = options.discourse.createTemplate({ anchor, requestedBy: "root" });
					return {
						content: [{ type: "text", text: `Created template ${template.id}: ${template.anchor}` }],
						details:
							params.action === "createTemplate"
								? { action: "createTemplate", template }
								: { action: "createContract", contract: template },
					};
				}

				case "approveTemplate":
				case "approveContract": {
					const templateId = requireNonEmpty(
						params.templateId ?? params.contractId,
						"approveTemplate requires `templateId`.",
					);
					const template = options.discourse.approveTemplate({ templateId, approvedBy: "operator" });
					return {
						content: [{ type: "text", text: `Approved template ${template.id}.` }],
						details:
							params.action === "approveTemplate"
								? { action: "approveTemplate", template }
								: { action: "approveContract", contract: template },
					};
				}

				case "rejectTemplate":
				case "rejectContract": {
					const templateId = requireNonEmpty(
						params.templateId ?? params.contractId,
						"rejectTemplate requires `templateId`.",
					);
					const template = options.discourse.rejectTemplate({
						templateId,
						approvedBy: "operator",
						rationale: params.reason?.trim() || undefined,
						input: params.message?.trim() || undefined,
					});
					return {
						content: [{ type: "text", text: `Rejected template ${template.id}.` }],
						details:
							params.action === "rejectTemplate"
								? { action: "rejectTemplate", template }
								: { action: "rejectContract", contract: template },
					};
				}

				case "requestStamp": {
					const templateId = requireNonEmpty(
						params.templateId ?? params.contractId,
						"requestStamp requires `templateId`.",
					);
					const stamp = options.discourse.requestStamp({
						templateId,
						requestedBy: "operator",
					});
					return {
						content: [{ type: "text", text: `Requested stamp ${stamp.id} for template ${templateId}.` }],
						details: { action: "requestStamp", stampId: stamp.id, templateId },
					};
				}

				case "createTopic": {
					const title = requireNonEmpty(params.topic, "createTopic requires `topic`.");
					const templateId = params.templateId?.trim() || params.contractId?.trim() || undefined;
					const topic = options.discourse.createTopic({
						title,
						templateId,
						contractId: templateId,
						address: params.address?.trim() || undefined,
					});
					return {
						content: [{ type: "text", text: `Created topic ${formatTopic(topic)}.` }],
						details: { action: "createTopic", topic },
					};
				}

				case "listTopics": {
					const topics = options.discourse.listTopics(
						params.templateId?.trim() || params.contractId?.trim() || undefined,
					);
					return {
						content: [{ type: "text", text: formatTopicList(topics) }],
						details: { action: "listTopics", topics },
					};
				}

				case "relocateTopic": {
					const topicId = requireNonEmpty(params.topicId, "relocateTopic requires `topicId`.");
					const forumId = requireNonEmpty(params.forumId, "relocateTopic requires `forumId`.");
					const topic = options.discourse.relocateTopic({
						topicId,
						forumId,
						relocatedBy: "root",
						reason: params.reason?.trim() || undefined,
						labels: (params.labels ?? []).map((selector) => {
							const [key, value] = selector.split(":", 2);
							return { key, value, source: "coordinator" as const };
						}),
					});
					return {
						content: [{ type: "text", text: `Relocated topic ${formatTopic(topic)}.` }],
						details: { action: "relocateTopic", topic },
					};
				}

				case "archiveTopic": {
					const topicId = requireNonEmpty(params.topicId, "archiveTopic requires `topicId`.");
					const topic = options.discourse.archiveTopic({
						topicId,
						archivedBy: "root",
						reason: params.reason?.trim() || undefined,
					});
					return {
						content: [{ type: "text", text: `Archived topic ${formatTopic(topic)}.` }],
						details: { action: "archiveTopic", topic },
					};
				}

				case "assignTopic": {
					const topicId = requireNonEmpty(params.topicId, "assignTopic requires `topicId`.");
					const topic = options.discourse.getTopic(topicId);
					if (!topic) {
						throw new Error(`Unknown topic: ${topicId}`);
					}

					const reference = requireNonEmpty(
						params.reference,
						"assignTopic requires `reference` with a child name or blueprint path.",
					);
					const childDefinition = resolveAgentChildDefinition(
						options.getCurrentDefinition(),
						reference,
						options.cwd,
					);
					const agent = await options.manager.spawnAgent({
						definition: childDefinition,
						name: params.name,
						initialMessage: params.message ?? topic.title,
						templateId: topic.templateId ?? topic.satisfiesTemplateId ?? topic.contractId,
						discourseAddress: boardPathToAddress(topic.address),
						contractId: topic.contractId,
						topicId: topic.id,
						threadId: topic.threadId,
					});
					const summary = options.discourse
						.listTopics(topic.templateId ?? topic.satisfiesTemplateId ?? topic.contractId)
						.find((entry) => entry.topic.id === topic.id);
					if (!summary) {
						throw new Error(`Assigned topic ${topic.id} could not be read back from discourse.`);
					}
					return {
						content: [{ type: "text", text: `Assigned ${topic.id} to ${formatAgent(agent)}.` }],
						details: { action: "assignTopic", agent, topic: summary },
					};
				}

				case "claimTopic": {
					const claim = options.discourse.claimTarget({
						claimedBy: "root",
						targetAddress: params.address?.trim() || undefined,
						topicId: params.topicId?.trim() || undefined,
						threadId: params.threadId?.trim() || undefined,
						labelSelectors: params.labels ?? undefined,
						leaseMs: params.leaseMs,
						reason: params.reason?.trim() || undefined,
					});
					const topic = options.discourse.readThread({ threadId: claim.threadId });
					return {
						content: [{ type: "text", text: `Claimed ${claim.targetAddress} as ${claim.id}.` }],
						details: {
							action: "claimTopic",
							claimId: claim.id,
							topic: options.discourse.listTopics().find((entry) => entry.topic.id === topic.topic.id)!,
						},
					};
				}

				case "releaseClaim": {
					const claimId = requireNonEmpty(params.claimId, "releaseClaim requires `claimId`.");
					const claim = options.discourse.releaseClaim({
						claimId,
						releasedBy: "root",
						reason: params.reason?.trim() || undefined,
					});
					return {
						content: [{ type: "text", text: `Released claim ${claim.id} on ${claim.targetAddress}.` }],
						details: { action: "releaseClaim", claimId: claim.id },
					};
				}

				case "readThread": {
					const thread = options.discourse.readThread({
						threadId: params.threadId?.trim() || undefined,
						topicId: params.topicId?.trim() || undefined,
						address: params.address?.trim() || undefined,
					});
					return {
						content: [{ type: "text", text: formatThread(thread) }],
						details: { action: "readThread", thread },
					};
				}

				case "listAgents": {
					const agents = options.manager.listAgents();
					return {
						content: [{ type: "text", text: formatAgentList(agents) }],
						details: { action: "listAgents", agents },
					};
				}

				case "spawnAgent": {
					const reference = requireNonEmpty(
						params.reference,
						"spawnAgent requires `reference` with a child name or blueprint path.",
					);
					const childDefinition = resolveAgentChildDefinition(
						options.getCurrentDefinition(),
						reference,
						options.cwd,
					);
					const agent = await options.manager.spawnAgent({
						definition: childDefinition,
						name: params.name,
						initialMessage: params.message,
					});
					return {
						content: [
							{
								type: "text",
								text: `Spawned ${formatAgent(agent)} from ${childDefinition.sourcePath ?? reference}.`,
							},
						],
						details: { action: "spawnAgent", agent },
					};
				}

				case "signalAgent": {
					const agentId = requireNonEmpty(params.agentId, "signalAgent requires `agentId`.");
					const signal = (params.signal ?? "abort") as SupervisorSignal;
					const agent = await options.manager.signalAgent({ agentId, signal });
					return {
						content: [{ type: "text", text: `Sent ${signal} to ${formatAgent(agent)}.` }],
						details: { action: "signalAgent", agent, signal },
					};
				}

				case "killAgent": {
					const agentId = requireNonEmpty(params.agentId, "killAgent requires `agentId`.");
					const agent = await options.manager.killAgent({ agentId });
					return {
						content: [{ type: "text", text: `Killed ${formatAgent(agent)}.` }],
						details: { action: "killAgent", agent },
					};
				}

				case "sendAgentMessage": {
					const agentId = requireNonEmpty(params.agentId, "sendAgentMessage requires `agentId`.");
					const message = requireNonEmpty(params.message, "sendAgentMessage requires `message`.");
					const agent = await options.manager.sendAgentMessage({ agentId, message });
					return {
						content: [{ type: "text", text: `Delivered message to ${formatAgent(agent)}.` }],
						details: { action: "sendAgentMessage", agent },
					};
				}
			}
		},
	};
}
