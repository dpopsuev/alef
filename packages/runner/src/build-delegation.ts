import type { AgentDefinitionSurfaceInput } from "@dpopsuev/alef-agent-blueprint";
import type { Agent } from "@dpopsuev/alef-corpus";
import { createDelegateOrgan } from "@dpopsuev/alef-organ-delegate";
import type { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { createFactoryOrgan } from "@dpopsuev/alef-organ-factory";
import { createFsOrgan } from "@dpopsuev/alef-organ-fs";
import type { Api, Model } from "@dpopsuev/alef-organ-llm";
import { createNodeshOrgan } from "@dpopsuev/alef-organ-nodesh";
import { createOrchestrationOrgan } from "@dpopsuev/alef-organ-orchestration";
import { createRouterOrgan } from "@dpopsuev/alef-organ-router";
import { createShellOrgan } from "@dpopsuev/alef-organ-shell";
import { createWebOrgan } from "@dpopsuev/alef-organ-web";
import type { Args } from "./args.js";
import { InProcessStrategy } from "./strategies/in-process.js";

export async function buildDelegation(
	args: Args,
	model: Model<Api>,
	agent: Agent,
	dialog: DialogOrgan,
	blueprintSurfaces: AgentDefinitionSurfaceInput[],
): Promise<void> {
	const delegateOrgan = createDelegateOrgan({
		strategies: {
			explore: new InProcessStrategy(
				[createFsOrgan({ cwd: args.cwd }), createWebOrgan()],
				model,
				`You are a read-only exploration agent. Your only job is to read files, search code, and fetch URLs, then report findings concisely.

Rules — follow these exactly:
- No emojis. Never. In any part of your response.
- No filler ("Great!", "Certainly!", "Let me look at..."). Start with the finding.
- No preamble. Do not narrate what you are about to do. Run the tool, return the result.
- Never write files, modify state, or execute commands that change anything.
- Return absolute file paths when listing files.
- Read files before describing them. Never claim what a file contains without reading it.
- If the caller asks you to read multiple files in parallel, do so — do not serialize reads you can batch.`,
			),
			general: new InProcessStrategy(
				[
					createFsOrgan({ cwd: args.cwd }),
					createShellOrgan({ cwd: args.cwd }),
					createWebOrgan(),
					createNodeshOrgan({ cwd: args.cwd }),
				],
				model,
			),
		},
		cwd: args.cwd,
	});

	const orchestrationOrgan = createOrchestrationOrgan({
		cwd: args.cwd,
		onChildReady: (name, strategy) => delegateOrgan.registerStrategy(name, strategy),
	});

	agent.load(delegateOrgan);
	agent.load(orchestrationOrgan);
	agent.load(createFactoryOrgan({ cwd: args.cwd }));

	if (args.serve !== undefined) {
		const sseSurface = blueprintSurfaces.filter((surface) => surface.type === "sse");
		const allowedEvents = sseSurface.flatMap((surface) => surface.events ?? []);
		const router = createRouterOrgan({
			port: args.serve,
			allowedEvents,
			onMessage: (text) => dialog.receive(text, "user"),
		});
		agent.load(router);
		await router.ready();
		const addr = router.address() ?? { host: "127.0.0.1", port: 0 };
		console.error(`[alef] router listening on http://${addr.host}:${addr.port}`);
	}
}
