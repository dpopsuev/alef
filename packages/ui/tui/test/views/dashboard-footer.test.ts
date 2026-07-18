import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardFooter } from "../../src/views/dashboard-footer.js";
import { TuiStateStore } from "../../src/views/state.js";

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeFooter(overrides?: Partial<{ contextUsed: number; contextWindow: number }>) {
	const store = new TuiStateStore({
		modelId: "provider/test-model",
		thinkingLevel: "none",
		inputTokens: 0,
		outputTokens: 0,
		contextWindow: overrides?.contextWindow ?? 200_000,
		contextUsed: overrides?.contextUsed ?? 100_000,
		compacted: false,
		costUsd: 0,
	});
	const requestRender = vi.fn();
	const footer = new DashboardFooter({
		sessionId: "s1",
		cwd: "/tmp/project",
		store,
		requestRender,
		style: (s) => s,
		dimStyle: (s) => s,
		warnStyle: (s) => s,
		errorStyle: (s) => s,
	});
	return { footer, store, requestRender };
}

describe("DashboardFooter context bar", { tags: ["unit"] }, () => {
	const prevMotion = process.env.ALEF_REDUCED_MOTION;

	beforeEach(() => {
		vi.useFakeTimers();
		delete process.env.ALEF_REDUCED_MOTION;
		delete process.env.NO_MOTION;
	});

	afterEach(() => {
		vi.useRealTimers();
		if (prevMotion === undefined) delete process.env.ALEF_REDUCED_MOTION;
		else process.env.ALEF_REDUCED_MOTION = prevMotion;
	});

	it("renders context bar as the primary fill signal", () => {
		const { footer } = makeFooter({ contextUsed: 50_000, contextWindow: 200_000 });
		const line = stripAnsi(footer.render(120)[0]!);
		expect(line).toContain("ctx");
		expect(line).toMatch(/[█░]/);
		expect(line).toContain("50k/200k");
		expect(line).toContain("test-model");
	});

	it("blinks while compacting", () => {
		const { footer, requestRender } = makeFooter();
		footer.setCompacting(true);
		expect(footer.compactPhase).toBe("compacting");
		const on = stripAnsi(footer.render(100)[0]!);
		expect(on).toContain("compact");
		expect(on).toContain("█");

		vi.advanceTimersByTime(280);
		expect(requestRender).toHaveBeenCalled();
		const off = stripAnsi(footer.render(100)[0]!);
		expect(off).toContain("compact");
		expect(off).not.toContain("█");
		expect(off).toContain("░");
		footer.dispose();
	});

	it("drains fill from before to after on playDrain", () => {
		const { footer } = makeFooter({ contextUsed: 160_000, contextWindow: 200_000 });
		footer.playDrain(160_000, 40_000);
		expect(footer.compactPhase).toBe("draining");
		expect(footer.animatedContextUsed).toBe(160_000);

		vi.advanceTimersByTime(60 * 12);
		expect(footer.animatedContextUsed).toBeCloseTo(40_000, 0);
		expect(footer.compactPhase).toBe("celebrate");

		vi.advanceTimersByTime(280 * 4);
		expect(footer.compactPhase).toBe("idle");
		footer.dispose();
	});

	it("skips motion when ALEF_REDUCED_MOTION=1", () => {
		process.env.ALEF_REDUCED_MOTION = "1";
		const { footer } = makeFooter({ contextUsed: 160_000, contextWindow: 200_000 });
		footer.playDrain(160_000, 40_000);
		expect(footer.compactPhase).toBe("idle");
		expect(footer.animatedContextUsed).toBe(40_000);
		footer.dispose();
	});
});
