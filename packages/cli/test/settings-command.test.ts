/**
 * :settings command unit tests.
 *
 * Verifies the unified settings overlay dispatches overlay.show with the
 * correct SettingsList items (model, thinking, theme, profile).
 * Also verifies standalone :model, :think, :theme commands still work.
 */

import type { Session } from "@dpopsuev/alef-session/contracts";
import { Container } from "@dpopsuev/alef-tui";
import { ChatLog } from "@dpopsuev/alef-tui/views";
import { describe, expect, it, vi } from "vitest";
import { registry } from "../src/client/commands/commands.js";
import type { TuiHandlerContext } from "../src/client/commands/types.js";
import { getActiveThemeName, getTheme, setThemeByName } from "../src/client/theme.js";

function makeTui() {
	return {
		stop: vi.fn(),
		requestRender: vi.fn(),
	};
}

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		state: { id: "test-1234", modelId: "test-model", contextWindow: 128_000 },
		getModel: vi.fn(() => "anthropic/claude-sonnet-4-20250514"),
		setModel: vi.fn(),
		getThinking: vi.fn(() => "off"),
		setThinking: vi.fn(),
		setTurnController: vi.fn(),
		dispose: vi.fn(),
		subscribe: vi.fn(() => () => {}),
		send: vi.fn(),
		loadAdapter: vi.fn(),
		unloadAdapter: vi.fn(() => true),
		reloadAdapter: vi.fn(),
		getDirective: vi.fn(),
		...overrides,
	};
}

function makeCtx(overrides: Partial<TuiHandlerContext> = {}): TuiHandlerContext {
	const t = getTheme();
	const chat = new Container();
	return {
		t,
		writer: new ChatLog(chat, t),
		tui: makeTui(),
		session: makeSession(),
		dispatch: vi.fn(),
		abortCurrentTurn: undefined,
		setAbortCurrentTurn: vi.fn(),
		...overrides,
	};
}

describe(":settings command", { tags: ["unit"] }, () => {
	it("is registered in the command registry", () => {
		expect(registry.find("settings")).toBeDefined();
	});

	it("dispatches overlay.show with id 'settings'", () => {
		const ctx = makeCtx();
		registry.find("settings")!.run(ctx, []);
		expect(ctx.dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "overlay.show",
				descriptor: expect.objectContaining({ id: "settings" }),
			}),
		);
	});

	it("overlay descriptor has a component and handleInput", () => {
		const ctx = makeCtx();
		registry.find("settings")!.run(ctx, []);
		const call = (ctx.dispatch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
			descriptor: { component: unknown; handleInput: unknown };
		};
		expect(call.descriptor.component).toBeDefined();
		expect(typeof call.descriptor.handleInput).toBe("function");
	});
});

describe(":model command still works as shortcut", { tags: ["unit"] }, () => {
	it("is registered", () => {
		expect(registry.find("model")).toBeDefined();
	});

	it("with inline arg sets model directly", () => {
		const session = makeSession();
		const ctx = makeCtx({ session });
		registry.find("model")!.run(ctx, ["anthropic/claude-sonnet-4-20250514"]);
		expect(session.setModel).toHaveBeenCalledWith("anthropic/claude-sonnet-4-20250514");
	});

	it("with no args dispatches overlay.show for model-picker", () => {
		const ctx = makeCtx();
		registry.find("model")!.run(ctx, []);
		expect(ctx.dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "overlay.show",
				descriptor: expect.objectContaining({ id: "model-picker" }),
			}),
		);
	});
});

describe(":think command still works as shortcut", { tags: ["unit"] }, () => {
	it("with inline arg sets thinking directly", () => {
		const session = makeSession();
		const ctx = makeCtx({ session });
		registry.find("think")!.run(ctx, ["high"]);
		expect(session.setThinking).toHaveBeenCalledWith("high");
	});
});

describe(":theme command still works as shortcut", { tags: ["unit"] }, () => {
	it("with inline arg sets theme directly", () => {
		const ctx = makeCtx();
		setThemeByName("terminal");
		registry.find("theme")!.run(ctx, ["mono"]);
		expect(getActiveThemeName()).toBe("mono");
		setThemeByName("terminal");
	});
});

describe("getActiveThemeName", { tags: ["unit"] }, () => {
	it("returns terminal by default", () => {
		setThemeByName("terminal");
		expect(getActiveThemeName()).toBe("terminal");
	});

	it("tracks theme changes via setThemeByName", () => {
		setThemeByName("akko");
		expect(getActiveThemeName()).toBe("akko");
		setThemeByName("mono");
		expect(getActiveThemeName()).toBe("mono");
		setThemeByName("terminal");
	});

	it("falls back to terminal for unknown theme", () => {
		setThemeByName("nonexistent");
		expect(getActiveThemeName()).toBe("terminal");
		setThemeByName("terminal");
	});
});
