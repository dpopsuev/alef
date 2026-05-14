import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const blueprintSrcIndex = fileURLToPath(new URL("../blueprint/src/index.ts", import.meta.url));
const codingAgentSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const runtimeBoard = fileURLToPath(new URL("../runtime/src/board.ts", import.meta.url));
const runtimePlatform = fileURLToPath(new URL("../runtime/src/platform.ts", import.meta.url));
const runtimeAgentSessionRuntime = fileURLToPath(new URL("../runtime/src/agent-session-runtime.ts", import.meta.url));
const runtimeAgentSessionServices = fileURLToPath(new URL("../runtime/src/agent-session-services.ts", import.meta.url));
const runtimeSrcIndex = fileURLToPath(new URL("../runtime/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));
const organFsSrcIndex = fileURLToPath(new URL("../organ-fs/src/index.ts", import.meta.url));
const organShellSrcIndex = fileURLToPath(new URL("../organ-shell/src/index.ts", import.meta.url));
const organShellMount = fileURLToPath(new URL("../organ-shell/src/mount.ts", import.meta.url));
const organLectorSrcIndex = fileURLToPath(new URL("../organ-lector/src/index.ts", import.meta.url));
const organAiSrcIndex = fileURLToPath(new URL("../organ-ai/src/index.ts", import.meta.url));
const organAiCompleterAdapter = fileURLToPath(new URL("../organ-ai/src/completer/adapter.ts", import.meta.url));
const discourseSrcIndex = fileURLToPath(new URL("../discourse/src/index.ts", import.meta.url));
const organDialogSrcIndex = fileURLToPath(new URL("../organ-dialog/src/index.ts", import.meta.url));
const organMonologSrcIndex = fileURLToPath(new URL("../organ-monolog/src/index.ts", import.meta.url));
const organDiscourseSrcIndex = fileURLToPath(new URL("../organ-discourse/src/index.ts", import.meta.url));
const organCompleterSrcIndex = fileURLToPath(new URL("../organ-completer/src/index.ts", import.meta.url));
const organSupervisorSrcIndex = fileURLToPath(new URL("../organ-supervisor/src/index.ts", import.meta.url));
const nerveSrcIndex = fileURLToPath(new URL("../nerve/src/index.ts", import.meta.url));
const nerveBus = fileURLToPath(new URL("../nerve/src/bus.ts", import.meta.url));
const nerveEventLog = fileURLToPath(new URL("../nerve/src/event-log.ts", import.meta.url));
const nerveProtocol = fileURLToPath(new URL("../nerve/src/protocol.ts", import.meta.url));
const nerveSpine = fileURLToPath(new URL("../nerve/src/spine.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@alef\/ai$/, replacement: aiSrcIndex },
			{ find: /^@alef\/ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@alef\/agent-core$/, replacement: agentSrcIndex },
			{ find: /^@alef\/tui$/, replacement: tuiSrcIndex },
			{ find: /^@dpopsuev\/alef-ai$/, replacement: aiSrcIndex },
			{ find: /^@dpopsuev\/alef-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@dpopsuev\/alef-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@dpopsuev\/alef-agent-blueprint$/, replacement: blueprintSrcIndex },
			{ find: /^@dpopsuev\/alef-agent-runtime\/board$/, replacement: runtimeBoard },
			{ find: /^@dpopsuev\/alef-agent-runtime\/platform$/, replacement: runtimePlatform },
			{ find: /^@dpopsuev\/alef-agent-runtime$/, replacement: runtimeSrcIndex },
			{ find: /^@dpopsuev\/alef-agent-runtime\/agent-session-runtime$/, replacement: runtimeAgentSessionRuntime },
			{ find: /^@dpopsuev\/alef-agent-runtime\/agent-session-services$/, replacement: runtimeAgentSessionServices },
			{ find: /^@dpopsuev\/alef-organ-fs$/, replacement: organFsSrcIndex },
			{ find: /^@dpopsuev\/alef-organ-shell$/, replacement: organShellSrcIndex },
			{ find: /^@dpopsuev\/alef-organ-shell\/mount$/, replacement: organShellMount },
			{ find: /^@dpopsuev\/alef-organ-lector$/, replacement: organLectorSrcIndex },
			{ find: /^@dpopsuev\/alef-organ-ai$/, replacement: organAiSrcIndex },
			{ find: /^@dpopsuev\/alef-organ-ai\/completer\/adapter$/, replacement: organAiCompleterAdapter },
			{ find: /^@dpopsuev\/alef-discourse$/, replacement: discourseSrcIndex },
			{ find: /^@dpopsuev\/alef-organ-dialog$/, replacement: organDialogSrcIndex },
			{ find: /^@dpopsuev\/alef-organ-monolog$/, replacement: organMonologSrcIndex },
			{ find: /^@dpopsuev\/alef-organ-discourse$/, replacement: organDiscourseSrcIndex },
			{ find: /^@dpopsuev\/alef-organ-supervisor$/, replacement: organSupervisorSrcIndex },
			{ find: /^@dpopsuev\/alef-organ-completer$/, replacement: organCompleterSrcIndex },
			{ find: /^@dpopsuev\/alef-nerve$/, replacement: nerveSrcIndex },
			{ find: /^@dpopsuev\/alef-nerve\/bus$/, replacement: nerveBus },
			{ find: /^@dpopsuev\/alef-nerve\/event-log$/, replacement: nerveEventLog },
			{ find: /^@dpopsuev\/alef-nerve\/protocol$/, replacement: nerveProtocol },
			{ find: /^@dpopsuev\/alef-nerve\/spine$/, replacement: nerveSpine },
			{ find: /^@dpopsuev\/alef-coding-agent$/, replacement: codingAgentSrcIndex },
			{ find: /^@dpopsuev\/alef-tui$/, replacement: tuiSrcIndex },
		],
	},
});
