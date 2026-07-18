/**
 * E2E: :model pick → process restart → boot selects the last picked model.
 *
 * Pick is exercised via SessionHandle.setModel (same path as :model).
 * Restart is a fresh subprocess with isolated XDG state and no --model.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasCredentials } from "@dpopsuev/alef-agent/model";
import { afterEach, describe, expect, it } from "vitest";
import { SessionHandle } from "../src/boot/handle.js";

const MAIN = fileURLToPath(new URL("../src/entrypoint.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const TSCONFIG = fileURLToPath(new URL("../../../tsconfig.json", import.meta.url));

const PICKED = "claude-haiku-4-5";
const OTHER = "claude-sonnet-4-5";

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function run(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
	return new Promise((resolve) => {
		const proc = spawn(TSX, [MAIN, ...args], {
			env: { ...env, TSX_TSCONFIG_PATH: TSCONFIG },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		proc.stdin.end();
		proc.on("close", (code) => {
			resolve({ stdout, stderr, exitCode: code ?? 1 });
		});
	});
}

function stubModel(id: string) {
	return {
		id,
		name: id,
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

describe("model pick survives restart", { tags: ["e2e"] }, () => {
	const previous = {
		state: process.env.XDG_STATE_HOME,
		config: process.env.XDG_CONFIG_HOME,
		data: process.env.XDG_DATA_HOME,
		cache: process.env.XDG_CACHE_HOME,
		alefModel: process.env.ALEF_MODEL,
	};

	afterEach(() => {
		for (const [key, value] of Object.entries({
			XDG_STATE_HOME: previous.state,
			XDG_CONFIG_HOME: previous.config,
			XDG_DATA_HOME: previous.data,
			XDG_CACHE_HOME: previous.cache,
			ALEF_MODEL: previous.alefModel,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it.skipIf(!hasCredentials())(
		"setModel persists pick; fresh --preflight boot selects it over ALEF_MODEL",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "alef-model-persist-e2e-"));
			const stateHome = join(root, "state");
			const configHome = join(root, "config");
			const dataHome = join(root, "data");
			const cacheHome = join(root, "cache");
			mkdirSync(join(configHome, "alef"), { recursive: true });

			process.env.XDG_STATE_HOME = stateHome;
			process.env.XDG_CONFIG_HOME = configHome;
			process.env.XDG_DATA_HOME = dataHome;
			process.env.XDG_CACHE_HOME = cacheHome;
			delete process.env.ALEF_MODEL;

			const boot = stubModel(OTHER);
			const handle = new SessionHandle({
				state: { id: "s", modelId: boot.id, contextWindow: boot.contextWindow },
				model: boot,
				thinkingState: { level: "medium" },
				controller: { receive: () => {}, send: () => {} } as never,
				agent: { dispose: () => {}, publishEvent: () => {}, load: () => {} } as never,
				directives: { register: () => {} } as never,
				args: {} as never,
				log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
				observers: new Set(),
				modelFactory: (id) => stubModel(id),
				discussion: {
					home: { forumId: "f", topicId: "t", topicTitle: "" },
					active: { forumId: "f", topicId: "t", topicTitle: "" },
					subscriptions: [],
				},
				discourseBackend: { append: async () => ({ id: "p" }) } as never,
				humanAddress: "human",
				agentAddress: "agent",
			});

			// Same path as :model <id> / picker onSelect.
			handle.setModel(PICKED);
			expect(handle.getModel()).toBe(PICKED);

			const cwd = mkdtempSync(join(tmpdir(), "alef-model-persist-cwd-"));
			const result = await run(["--cwd", cwd, "--preflight"], {
				...process.env,
				XDG_STATE_HOME: stateHome,
				XDG_CONFIG_HOME: configHome,
				XDG_DATA_HOME: dataHome,
				XDG_CACHE_HOME: cacheHome,
				ALEF_MODEL: OTHER,
				HOME: root,
			});

			expect(result.exitCode, result.stderr + result.stdout).toBe(0);
			expect(result.stdout).toMatch(new RegExp(`\\[ok\\] model:.*${PICKED}`));
			expect(result.stdout).not.toMatch(new RegExp(`\\[ok\\] model:.*${OTHER}`));
		},
		120_000,
	);
});
