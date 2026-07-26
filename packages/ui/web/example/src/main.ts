/**
 * Alef Web UI — HTTP client demo.
 *
 * Wires @dpopsuev/alef-web-ui components against a running Alef runner instance.
 *
 * To use:
 *   1. Start the runner: npx tsx packages/cli/src/entrypoint.ts --serve 0 --no-tui
 *   2. Open this page in a browser (npm run dev in this directory)
 *   3. The chat panel connects to the runner at the URL shown in the header
 *
 * The runner handles model selection, API keys, and all tool execution.
 * This client is a pure rendering layer over POST /message and GET /events.
 */

import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { ChatPanel, composeResourceTile, TileDesk, type TileInstance } from "@dpopsuev/alef-web-ui";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html, render } from "lit";
import { Settings } from "lucide";
import "./app.css";
import { HttpAgentClient } from "./http-agent-client.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_RUNNER_URL = "http://127.0.0.1:3000";

function getRunnerUrl(): string {
	return localStorage.getItem("alef.runnerUrl") ?? DEFAULT_RUNNER_URL;
}

function setRunnerUrl(url: string): void {
	localStorage.setItem("alef.runnerUrl", url);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let client: HttpAgentClient = new HttpAgentClient(getRunnerUrl());
let chatPanel: ChatPanel = new ChatPanel();
const tileDesk = new TileDesk();
let latestMeterSnapshot: unknown;
let meterSnapshotUnsubscribe: (() => void) | undefined;
let activeView: "chat" | "alignment" = "chat";
let showUrlEditor = false;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const bindMeterSnapshots = () => {
	meterSnapshotUnsubscribe?.();
	meterSnapshotUnsubscribe = client.subscribeMeterSnapshots((snapshot) => {
		latestMeterSnapshot = snapshot;
		if (activeView === "alignment") renderApp();
	});
};

const initChatPanel = async () => {
	await chatPanel.setAgent(client, {
		onApiKeyRequired: undefined,
		toolsFactory: undefined,
	});
	bindMeterSnapshots();
};

const reconnect = async (url: string) => {
	setRunnerUrl(url);
	meterSnapshotUnsubscribe?.();
	client.dispose();
	client = new HttpAgentClient(url);
	chatPanel = new ChatPanel();
	latestMeterSnapshot = undefined;
	await initChatPanel();
	renderApp();
};

const renderApp = () => {
	const app = document.getElementById("app");
	if (!app) return;

	const runnerUrl = getRunnerUrl();
	if (latestMeterSnapshot !== undefined) {
		const tiles: TileInstance[] = [
			{ definition: composeResourceTile("product"), data: latestMeterSnapshot },
			{ definition: composeResourceTile("engineering"), data: latestMeterSnapshot },
		];
		tileDesk.tiles = tiles;
	}

	render(
		html`
			<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
				<!-- Header -->
				<div class="flex items-center justify-between border-b border-border shrink-0 px-4 py-2">
					<div class="flex items-center gap-3">
						<span class="text-sm font-semibold">Alef Web UI</span>
						${
							showUrlEditor
								? html`
								<form
									class="flex items-center gap-2"
									@submit=${async (e: SubmitEvent) => {
										e.preventDefault();
										const input = (e.target as HTMLFormElement).querySelector("input") as HTMLInputElement;
										const url = input.value.trim();
										if (url) {
											showUrlEditor = false;
											await reconnect(url);
										}
									}}
								>
									<input
										type="url"
										value=${runnerUrl}
										class="text-xs border border-border rounded px-2 py-1 bg-background w-56"
										placeholder="http://127.0.0.1:3000"
										autofocus
									/>
									<button type="submit" class="text-xs px-2 py-1 rounded bg-primary text-primary-foreground">
										Connect
									</button>
									<button
										type="button"
										class="text-xs px-2 py-1 rounded"
										@click=${() => {
											showUrlEditor = false;
											renderApp();
										}}
									>
										Cancel
									</button>
								</form>
							`
								: html`
								<span class="text-xs text-muted-foreground font-mono">${runnerUrl}</span>
							`
						}
					</div>
					<div class="flex items-center gap-1">
						${Button({
							variant: activeView === "chat" ? "secondary" : "ghost",
							size: "sm",
							children: "Chat",
							onClick: () => {
								activeView = "chat";
								renderApp();
							},
						})}
						${Button({
							variant: activeView === "alignment" ? "secondary" : "ghost",
							size: "sm",
							children: "Alignment",
							onClick: () => {
								activeView = "alignment";
								renderApp();
							},
						})}
						${Button({
							variant: "ghost",
							size: "sm",
							children: icon(Settings, "sm"),
							onClick: () => {
								showUrlEditor = !showUrlEditor;
								renderApp();
							},
							title: "Configure runner URL",
						})}
						<theme-toggle></theme-toggle>
					</div>
				</div>

				<div class="min-h-0 flex-1">
					${
						activeView === "chat"
							? chatPanel
							: latestMeterSnapshot === undefined
								? html`<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
									Run an agent turn to populate the alignment desk.
								</div>`
								: tileDesk
					}
				</div>
			</div>
		`,
		app,
	);
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
	const app = document.getElementById("app");
	if (!app) throw new Error("App container not found");

	render(
		html`
			<div class="w-full h-screen flex items-center justify-center bg-background text-foreground">
				<div class="text-muted-foreground text-sm">Connecting to runner…</div>
			</div>
		`,
		app,
	);

	await initChatPanel();
	renderApp();
}

init();
