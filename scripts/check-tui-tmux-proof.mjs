import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ALEF_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WARMUP_PROMPT = "Run the tmux TUI warmup response.";
const TYPED_PROMPT = "Run the tmux TUI typed-input response.";
const WARMUP_TOKEN = "TMUX_TUI_WARMUP_OK";
const RESULT_TOKEN = "TMUX_TUI_PROOF_OK";
const FATAL_MARKERS = [
	"No API provider registered for api: faux-tmux-proof",
	"Dolt CLI is required for Alef discourse storage but was not found",
];
const SESSION_NAME = `alef-tui-proof-${Date.now()}`;
const TIMEOUT_MS = 40_000;
const POLL_INTERVAL_MS = 300;

function shellQuote(value) {
	if (value.length === 0) {
		return "''";
	}
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function runCommand(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf-8",
		...options,
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		const stdout = result.stdout?.trim() ?? "";
		const stderr = result.stderr?.trim() ?? "";
		throw new Error(
			`${command} ${args.join(" ")} failed with exit code ${result.status}\n${stdout}\n${stderr}`.trim(),
		);
	}
	return result.stdout ?? "";
}

function tmux(args, options) {
	return runCommand("tmux", args, options);
}

function ensureTmuxInstalled() {
	try {
		tmux(["-V"]);
	} catch (error) {
		throw new Error(
			`tmux is required for check:tui-tmux-proof. Install tmux and retry.\n${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function tryTmux(args) {
	try {
		tmux(args);
	} catch {
		// best effort for tmux versions that do not support an option
	}
}

function capturePane(sessionName) {
	return tmux(["capture-pane", "-t", sessionName, "-p", "-J", "-S", "-200"]);
}

async function waitForToken(sessionName, token, timeoutMs) {
	const start = Date.now();
	let lastCapture = "";
	while (Date.now() - start < timeoutMs) {
		lastCapture = capturePane(sessionName);
		if (lastCapture.includes(token)) {
			return lastCapture;
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_INTERVAL_MS));
	}
	throw new Error(`Timed out waiting for token "${token}".\nLast capture:\n${lastCapture}`);
}

function assertNoFatalMarkers(output) {
	for (const marker of FATAL_MARKERS) {
		if (output.includes(marker)) {
			throw new Error(`Detected fatal marker in tmux pane output: ${marker}\n${output}`);
		}
	}
}

function createProofExtension(extensionPath) {
	const source = `import { createAssistantMessageEventStream } from "@dpopsuev/alef-ai";

export default function proofExtension(pi) {
  let callCount = 0;

  function streamSimple(model) {
    const stream = createAssistantMessageEventStream();
    callCount += 1;
    const responseText = callCount === 1 ? "${WARMUP_TOKEN}" : "${RESULT_TOKEN}";
    const partial = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    queueMicrotask(() => {
      stream.push({ type: "start", partial });
      stream.push({ type: "text_start", contentIndex: 0, partial });
      partial.content[0].text = responseText;
      stream.push({ type: "text_delta", contentIndex: 0, delta: responseText, partial });
      stream.push({ type: "text_end", contentIndex: 0, content: responseText, partial });
      stream.push({ type: "done", reason: "stop", message: partial });
      stream.end(partial);
    });
    return stream;
  }

  pi.registerProvider("faux", {
    baseUrl: "https://example.invalid/faux",
    apiKey: "faux-key",
    api: "faux-tmux-proof",
    streamSimple,
    models: [
      {
        id: "faux-headless",
        name: "Faux Headless",
        api: "faux-tmux-proof",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 512,
        baseUrl: "https://example.invalid/faux",
      },
    ],
  });
}
`;
	writeFileSync(extensionPath, source, "utf-8");
}

async function main() {
	ensureTmuxInstalled();

	const root = mkdtempSync(join(tmpdir(), "alef-tui-proof-"));
	const agentDir = join(root, "agent");
	const extensionPath = join(root, "tmux-proof-extension.mjs");
	mkdirSync(agentDir, { recursive: true });
	createProofExtension(extensionPath);

	try {
		tmux(["new-session", "-d", "-s", SESSION_NAME, "-x", "100", "-y", "28"]);
		tryTmux(["set-option", "-t", SESSION_NAME, "-g", "extended-keys", "on"]);
		tryTmux(["set-option", "-t", SESSION_NAME, "-g", "extended-keys-format", "csi-u"]);

		const command = [
			`cd ${shellQuote(ALEF_ROOT)}`,
			"&&",
			`ALEF_OFFLINE=1`,
			`ALEF_SKIP_VERSION_CHECK=1`,
			`ALEF_DISCOURSE_DRIVER=memory`,
			`ALEF_CODING_AGENT_DIR=${shellQuote(agentDir)}`,
			`bash ./alef-test.sh`,
			`--provider`,
			`faux`,
			`--model`,
			`faux-headless`,
			`--extension`,
			shellQuote(extensionPath),
			`--no-skills`,
			`--no-prompt-templates`,
			`--no-themes`,
			`--no-context-files`,
			`--no-session`,
			shellQuote(WARMUP_PROMPT),
		].join(" ");

		tmux(["send-keys", "-t", SESSION_NAME, command, "Enter"]);
		await waitForToken(SESSION_NAME, WARMUP_TOKEN, TIMEOUT_MS);
		tmux(["send-keys", "-t", SESSION_NAME, TYPED_PROMPT, "Enter"]);
		await waitForToken(SESSION_NAME, RESULT_TOKEN, TIMEOUT_MS);
		assertNoFatalMarkers(capturePane(SESSION_NAME));

		console.log("tmux TUI proof passed.");
	} finally {
		try {
			tmux(["kill-session", "-t", SESSION_NAME]);
		} catch {
			// best effort
		}
		rmSync(root, { recursive: true, force: true });
	}
}

await main();
