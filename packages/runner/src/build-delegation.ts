import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAgentOrgan } from "@dpopsuev/alef-adapter-agent";
import { createFactoryOrgan } from "@dpopsuev/alef-adapter-factory";
import type { AgentDefinitionSurfaceInput } from "@dpopsuev/alef-agent-blueprint";
import { DEFAULT_COMPILED_DEFINITION, materializeBlueprint } from "@dpopsuev/alef-agent-blueprint";
import { createRouterOrgan } from "@dpopsuev/alef-gateway";
import type { Api, Message, Model } from "@dpopsuev/alef-llm";
import type { Agent } from "@dpopsuev/alef-runtime";
import { InProcessStrategy } from "@dpopsuev/alef-runtime";
import type { Args } from "./args.js";
import type { AgentEvent, Session } from "./session.js";
import { buildSubagentFactory } from "./subagent-factory.js";

async function createRouter(
	servePort: number,
	blueprintSurfaces: AgentDefinitionSurfaceInput[],
	session: Session,
	args: Args,
	agent: Agent,
): Promise<void> {
	const sseSurface = blueprintSurfaces.filter((surface) => surface.type === "sse");
	const allowedEvents = sseSurface.flatMap((surface) => surface.events ?? []);
	const router = createRouterOrgan({
		port: servePort,
		allowedEvents,
		triggerEvent: "llm.input",
		onMessage: (text) => session.receive?.(text),
	});
	agent.load(router);
	await router.ready();
	const addr = router.address() ?? { host: "127.0.0.1", port: 0 };
	console.error(`[alef] router listening on http://${addr.host}:${addr.port}`);

	if (args.daemon) {
		session.subscribe((event: AgentEvent) => {
			router.notifyAgent(event);
		});
		const daemonDir = join(homedir(), ".alef");
		mkdirSync(daemonDir, { recursive: true });
		writeFileSync(
			join(daemonDir, "daemon.json"),
			JSON.stringify({
				port: addr.port,
				pid: process.pid,
				sessionId: session.state.id,
				cwd: args.cwd,
				startedAt: Date.now(),
			}),
		);
	}
}

export async function setupHttpSurface(
	args: Args,
	agent: Agent,
	session: Session,
	blueprintSurfaces: AgentDefinitionSurfaceInput[],
): Promise<void> {
	const servePort = args.daemon ? 0 : args.serve;
	if (servePort === undefined) return;

	await createRouter(servePort, blueprintSurfaces, session, args, agent);
}

const EXPLORE_ADAPTERS = [
	{ name: "fs", actions: [] as string[], toolNames: ["fs.read", "fs.grep", "fs.find"] },
	{ name: "web", actions: [] as string[], toolNames: [] as string[] },
];

const EXPLORE_SYSTEM_PROMPT = `You are a read-only exploration agent. Your only job is to read files, search code, and fetch URLs, then report findings concisely.

Rules — follow these exactly:
- No emojis. Never. In any part of your response.
- No filler ("Great!", "Certainly!", "Let me look at..."). Start with the finding.
- No preamble. Do not narrate what you are about to do. Run the tool, return the result.
- Never write files, modify state, or execute commands that change anything.
- Return absolute file paths when listing files.
- Read files before describing them. Never claim what a file contains without reading it.
- If the caller asks you to read multiple files in parallel, do so — do not serialize reads you can batch.`;

export async function buildDelegation(
	args: Args,
	model: Model<Api>,
	agent: Agent,
	session: Session,
	blueprintSurfaces: AgentDefinitionSurfaceInput[],
	prepareStep?: (messages: Message[]) => Promise<Message[]>,
): Promise<void> {
	const materialiOpts = { cwd: args.cwd };

	const [{ organs: exploreOrgans }, { organs: generalOrgans }] = await Promise.all([
		materializeBlueprint({ ...DEFAULT_COMPILED_DEFINITION, organs: [...EXPLORE_ADAPTERS] }, materialiOpts),
		materializeBlueprint(DEFAULT_COMPILED_DEFINITION, materialiOpts),
	]);

	const factory = buildSubagentFactory({ model, trackConcurrentOps: true, forwardToolChunks: true });

	const agentOrgan = createAgentOrgan({
		cwd: args.cwd,
		strategies: {
			explore: new InProcessStrategy(exploreOrgans, factory, EXPLORE_SYSTEM_PROMPT),
			general: new InProcessStrategy(generalOrgans, factory),
		},
		replyEvent: "llm.response",
		getParentDirectives: prepareStep
			? async () => {
					const msgs = await prepareStep([]);
					const sys = msgs.find((m: Message) => (m as { role?: string }).role === "system");
					return typeof (sys as { content?: unknown } | undefined)?.content === "string"
						? (sys as { content: string }).content
						: "";
				}
			: undefined,
		materializeOrgans: async (names) => {
			const { organs } = await materializeBlueprint(
				{
					...DEFAULT_COMPILED_DEFINITION,
					organs: names.map((n) => ({ name: n, actions: [] as string[], toolNames: [] as string[] })),
				},
				materialiOpts,
			);
			return organs;
		},
		createAdHocSession: factory,
	});

	agent.load(agentOrgan);
	agent.load(createFactoryOrgan({ cwd: args.cwd }));

	const servePort = args.daemon ? 0 : args.serve;

	if (servePort !== undefined) {
		await createRouter(servePort, blueprintSurfaces, session, args, agent);
	}
}
