#!/usr/bin/env tsx

import { parseArgs } from "./args.js";
import { loadConfig } from "./config.js";
import { runDebugSession } from "./debug-session.js";
import { setupTrace } from "./debug-trace.js";
import { loadCorpus } from "./load-corpus.js";
import { loadSession } from "./load-session.js";
import { LocalSession } from "./local-session.js";
import { createRunnerLogger } from "./logger.js";
import { resolveStartupModel } from "./model.js";
import { setupOTel } from "./otel.js";
import { runAgent } from "./run-agent.js";
import { handleSelfUpdate, runPmCommand } from "./run-pm-command.js";

import { setupSupervisorIpc } from "./setup-supervisor-ipc.js";
import { detectDark, queryPalette, readAlacrittyOpacity } from "./terminal-bg.js";
import { loadTheme } from "./theme-loader.js";

// OTel must be registered before any tracer is acquired.
process.title = "alef";
const cfg = loadConfig();
setupOTel();

const args = parseArgs(process.argv.slice(2));

await runPmCommand(args);
await handleSelfUpdate(args);

// Handle debug subcommands before any session/agent setup.
if (args.debugSubcmd) {
	switch (args.debugSubcmd) {
		case "session":
			await runDebugSession(args.debugSubcmdArgs, args.cwd);
			break;
		default:
			console.error(`Unknown debug subcommand: ${args.debugSubcmd}`);
			console.error("Available: session");
			process.exit(1);
	}
	process.exit(0);
}

const willUseTui = !args.print && !args.json && !args.noTui && process.stdin.isTTY;
const log = createRunnerLogger(willUseTui, args.debug);
const trace = setupTrace(args.debug);
trace("boot", { pid: process.pid, cwd: args.cwd, model: args.modelId, tui: !args.noTui });

const session = await loadSession(args, willUseTui);

const corpus = await loadCorpus(args, cfg, log);
const { blueprintUpgradePolicy, blueprintPath } = corpus;

const { session: localSession, resolvedModelDisplay } = await LocalSession.create(
	args,
	cfg,
	log,
	session,
	corpus,
	resolveStartupModel(args, corpus.blueprintModelId, cfg),
	trace,
);

if (args.listTools) {
	for (const tool of localSession.tools) {
		console.log(tool.name);
	}
	process.exit(0);
}

if (args.listOrgans) {
	for (const organ of localSession.organs) {
		const suffix = [
			organ.labels?.length ? `[${organ.labels.join(", ")}]` : "",
			organ.description ? `— ${organ.description}` : "",
		]
			.filter(Boolean)
			.join(" ");
		console.log(suffix ? `${organ.name} ${suffix}` : organ.name);
	}
	process.exit(0);
}
const opacity = cfg.theme?.background_opacity ?? readAlacrittyOpacity();
const [isDark, terminalPalette] = await Promise.all([
	detectDark(opacity),
	queryPalette(Array.from({ length: 10 }, (_, i) => i + 5)),
]);
loadTheme(
	blueprintPath ? new URL("..", `file://${blueprintPath}`).pathname : undefined,
	cfg.theme?.name,
	cfg.theme?.colors,
	isDark,
	terminalPalette,
);

setupSupervisorIpc(blueprintUpgradePolicy);

await runAgent({
	args,
	resolvedModelDisplay,
	sessionId: session.id,
	contextWindow: localSession.state.contextWindow,
	getModel: () => localSession.getModel(),
	setModel: (id) => localSession.setModel(id),
	getThinking: () => localSession.getThinking(),
	setThinking: (level) => localSession.setThinking(level),
	setLLMAbortController: (ctrl) => localSession.setTurnController(ctrl),
	reloadOrgan: async (name, path) => localSession.reloadOrgan?.(name, path),
	getDirectiveAdapter: () => localSession.getDirective?.(),
	session: localSession,
});

trace("process.exit");
process.exit(0);
