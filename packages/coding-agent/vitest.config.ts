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
			{ find: /^@dpopsuev\/alef-coding-agent$/, replacement: codingAgentSrcIndex },
			{ find: /^@dpopsuev\/alef-tui$/, replacement: tuiSrcIndex },
		],
	},
});
