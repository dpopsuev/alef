/**
 * ExtensionOrchestrator — owns the ExtensionRunner lifecycle and bindings.
 *
 * Extracted from AgentSession. Previously these fields and methods lived
 * directly in AgentSession, preventing clean extraction:
 *
 *   _extensionRunner, _extensionRunnerRef
 *   _extensionUIContext, _extensionCommandContextActions
 *   _extensionShutdownHandler, _extensionErrorListener, _extensionErrorUnsubscriber
 *
 *   bindExtensions()
 *   extendResourcesFromExtensions()
 *   buildExtensionResourcePaths()
 *   getExtensionSourceLabel()
 *   _applyExtensionBindings()
 *   _bindExtensionCore()  — now delegates to buildExtensionAdapter()
 *
 * AgentSession retains:
 *   - The prompt orchestration loop (prompt(), steer(), followUp(), abort())
 *   - Event subscription and persistence (_handleAgentEvent)
 *   - A reference to this orchestrator via this._extensionOrch
 */

import { basename, dirname } from "node:path";
import type { ExtensionBindings } from "../agent-session.js";
import type { ModelRegistry } from "../model-registry.js";
import type { ResourceLoader } from "../resource-loader.js";
import type { SessionManager } from "../session-manager.js";
import { buildExtensionAdapter, type ExtensionAdapterSource } from "./adapter.js";
import type { ExtensionErrorListener, ShutdownHandler } from "./index.js";
import { ExtensionRunner } from "./runner.js";
import type { ExtensionCommandContextActions, ExtensionUIContext, LoadExtensionsResult } from "./types.js";

// ---------------------------------------------------------------------------
// ExtensionOrchestrator
// ---------------------------------------------------------------------------

export class ExtensionOrchestrator {
	private _runner!: ExtensionRunner;
	private _runnerRef?: { current?: ExtensionRunner };

	// Bindings set by interactive mode (after construction)
	private _uiContext?: ExtensionUIContext;
	private _commandContextActions?: ExtensionCommandContextActions;
	private _shutdownHandler?: ShutdownHandler;
	private _errorListener?: ExtensionErrorListener;
	private _errorUnsubscriber?: () => void;

	constructor(runnerRef?: { current?: ExtensionRunner }) {
		this._runnerRef = runnerRef;
	}

	// -------------------------------------------------------------------------
	// Runner access
	// -------------------------------------------------------------------------

	get runner(): ExtensionRunner {
		return this._runner;
	}

	/** True when interactive bindings have been applied (UI context, shutdown handler, etc.). */
	get hasBindings(): boolean {
		return !!(this._uiContext || this._commandContextActions || this._shutdownHandler || this._errorListener);
	}

	/** Flag values from the current runner (saved before reload). */
	getFlagValues(): Map<string, boolean | string> {
		return this._runner.getFlagValues();
	}

	/** Execute the registered shutdown handler (for ExtensionAdapterSource.executeShutdown). */
	executeShutdown(): void {
		this._shutdownHandler?.();
	}

	// -------------------------------------------------------------------------
	// Boot — creates the runner, binds core, applies any existing bindings
	// Called from _buildRuntime() on every runtime (re)build.
	// -------------------------------------------------------------------------

	boot(
		source: ExtensionAdapterSource,
		extensionsResult: LoadExtensionsResult,
		opts: {
			cwd: string;
			sessionManager: SessionManager;
			modelRegistry: ModelRegistry;
			flagValues?: Map<string, boolean | string>;
		},
	): void {
		if (opts.flagValues) {
			for (const [name, value] of opts.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		const runner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			opts.cwd,
			opts.sessionManager,
			opts.modelRegistry,
		);

		if (this._runnerRef) {
			this._runnerRef.current = runner;
		}

		// ISP + DIP: adapter factory builds the capability objects from the interface
		const { actions, contextActions, providerActions } = buildExtensionAdapter(source, runner);
		runner.bindCore(actions, contextActions, providerActions);

		// Apply any bindings already registered (e.g. TUI bound before first reload)
		this._applyBindings(runner);

		this._runner = runner;
	}

	// -------------------------------------------------------------------------
	// applyExternalBindings — called from AgentSession.bindExtensions()
	// -------------------------------------------------------------------------

	applyExternalBindings(bindings: ExtensionBindings): void {
		if (bindings.uiContext !== undefined) this._uiContext = bindings.uiContext;
		if (bindings.commandContextActions !== undefined) this._commandContextActions = bindings.commandContextActions;
		if (bindings.shutdownHandler !== undefined) this._shutdownHandler = bindings.shutdownHandler;
		if (bindings.onError !== undefined) this._errorListener = bindings.onError;
		this._applyBindings(this._runner);
	}

	// -------------------------------------------------------------------------
	// extendResources — called after bindExtensions() and after reload()
	// -------------------------------------------------------------------------

	async extendResources(
		reason: "startup" | "reload",
		cwd: string,
		resourceLoader: ResourceLoader,
		onResourcesUpdated: () => void,
	): Promise<void> {
		if (!this._runner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._runner.emitResourcesDiscover(cwd, reason);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		resourceLoader.extendResources({
			skillPaths: this._buildResourcePaths(skillPaths),
			promptPaths: this._buildResourcePaths(promptPaths),
			themePaths: this._buildResourcePaths(themePaths),
		});

		onResourcesUpdated();
	}

	// -------------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------------

	private _applyBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._uiContext);
		runner.bindCommandContext(this._commandContextActions);
		this._errorUnsubscriber?.();
		this._errorUnsubscriber = this._errorListener ? runner.onError(this._errorListener) : undefined;
	}

	private _buildResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => ({
			path: entry.path,
			metadata: {
				source: this._sourceLabel(entry.extensionPath),
				scope: "temporary" as const,
				origin: "top-level" as const,
				baseDir: entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath),
			},
		}));
	}

	private _sourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		return `extension:${base.replace(/\.(ts|js)$/, "")}`;
	}
}
