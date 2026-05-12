import { describe, expect, it, vi } from "vitest";
import { SessionImportFileNotFoundError } from "../src/core/agent-session-runtime.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type InteractiveModePrototype = {
	getPathCommandArgument(this: unknown, argsString: string): string | undefined;
	handleImportCommand(this: ImportCommandContext, argsString: string): Promise<void>;
};

type ImportCommandContext = {
	loadingAnimation?: { stop: () => void };
	statusContainer: { clear: () => void };
	runtimeHost: { importFromJsonl: (inputPath: string, cwdOverride?: string) => Promise<{ cancelled: boolean }> };
	showError: (message: string) => void;
	showStatus: (message: string) => void;
	showExtensionConfirm: (title: string, message: string) => Promise<boolean>;
	handleRuntimeSessionChange: () => Promise<void>;
	renderCurrentSessionState: () => void;
	handleFatalRuntimeError: (prefix: string, error: unknown) => Promise<never>;
	promptForMissingSessionCwd: (error: unknown) => Promise<string | undefined>;
	getPathCommandArgument: (argsString: string) => string | undefined;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode :import parsing", () => {
	it("strips quotes from :import path arguments", () => {
		expect(interactiveModePrototype.getPathCommandArgument('"path/to/session.jsonl"')).toBe("path/to/session.jsonl");
		expect(interactiveModePrototype.getPathCommandArgument('"path with spaces/session.jsonl"')).toBe(
			"path with spaces/session.jsonl",
		);
	});

	it("preserves apostrophes in unquoted :import path arguments", () => {
		expect(interactiveModePrototype.getPathCommandArgument("john's/session.jsonl")).toBe("john's/session.jsonl");
	});

	it("takes the first path token from arguments", () => {
		expect(interactiveModePrototype.getPathCommandArgument("/tmp/session.jsonl --unused")).toBe("/tmp/session.jsonl");
		expect(interactiveModePrototype.getPathCommandArgument("")).toBe(undefined);
	});

	it("passes unquoted path to runtimeHost.importFromJsonl", async () => {
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: ImportCommandContext = {
			statusContainer: { clear: vi.fn() },
			runtimeHost: { importFromJsonl },
			showError,
			showStatus,
			showExtensionConfirm,
			handleRuntimeSessionChange: vi.fn(async () => {}),
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, '"path/to/session.jsonl"');

		expect(showExtensionConfirm).toHaveBeenCalledWith(
			"Import session",
			"Replace current session with path/to/session.jsonl?",
		);
		expect(importFromJsonl).toHaveBeenCalledWith("path/to/session.jsonl");
		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Session imported from: path/to/session.jsonl");
	});

	it("passes unquoted apostrophe path to runtimeHost.importFromJsonl unchanged", async () => {
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: ImportCommandContext = {
			statusContainer: { clear: vi.fn() },
			runtimeHost: { importFromJsonl },
			showError,
			showStatus,
			showExtensionConfirm,
			handleRuntimeSessionChange: vi.fn(async () => {}),
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, "john's/session.jsonl");

		expect(importFromJsonl).toHaveBeenCalledWith("john's/session.jsonl");
		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Session imported from: john's/session.jsonl");
	});

	it("shows a non-fatal error when :import path does not exist", async () => {
		const importFromJsonl = vi.fn(async () => {
			throw new SessionImportFileNotFoundError("/tmp/missing-session.jsonl");
		});
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();
		const handleFatalRuntimeError = vi.fn(async () => {
			throw new Error("unexpected fatal error");
		});

		const context: ImportCommandContext = {
			statusContainer: { clear: vi.fn() },
			runtimeHost: { importFromJsonl },
			showError,
			showStatus,
			showExtensionConfirm,
			handleRuntimeSessionChange: vi.fn(async () => {}),
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError,
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		};

		await interactiveModePrototype.handleImportCommand.call(context, "/tmp/missing-session.jsonl");

		expect(showError).toHaveBeenCalledWith("Failed to import session: File not found: /tmp/missing-session.jsonl");
		expect(showStatus).not.toHaveBeenCalled();
		expect(handleFatalRuntimeError).not.toHaveBeenCalled();
	});
});
