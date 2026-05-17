import { InProcessNerve } from "@dpopsuev/alef-spine";
import { describe, expect, it } from "vitest";
import { createLectorOrgan } from "../src/organ.js";
import { StubLectorBackend } from "../src/stub-backend.js";

const AUTH_TS = `export function login(user: string): boolean {
  return user.length > 0;
}

export function logout(): void {}
`;

function drive(
	nerve: InProcessNerve,
	eventType: string,
	payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const off = nerve.asNerve().sense.subscribe(eventType, (e) => {
			off();
			if (e.isError) reject(new Error(e.errorMessage));
			else resolve(e.payload as Record<string, unknown>);
		});
		nerve.asNerve().motor.publish({
			type: eventType,
			payload: { ...payload, toolCallId: "tc-1" },
			correlationId: "test",
			timestamp: Date.now(),
		});
	});
}

describe("LectorOrgan — motor/sense contract", () => {
	const backend = new StubLectorBackend({ "auth.ts": AUTH_TS });
	const organ = createLectorOrgan({ cwd: "/workspace", backend });
	const nerve = new InProcessNerve();
	organ.mount(nerve.asNerve());

	it("lector.read returns content and symbols", async () => {
		const result = await drive(nerve, "lector.read", { path: "auth.ts" });
		expect(typeof result.content).toBe("string");
		const symbols = result.symbols as { name: string }[];
		expect(symbols.some((s) => s.name === "login")).toBe(true);
	});

	it("lector.read with symbol zooms into the block", async () => {
		const result = await drive(nerve, "lector.read", { path: "auth.ts", symbol: "logout" });
		expect(String(result.content)).toContain("logout");
		expect(String(result.content)).not.toContain("login(user");
	});

	it("lector.write persists content", async () => {
		await drive(nerve, "lector.write", { path: "new.ts", content: "export const x = 1;" });
		const result = await drive(nerve, "lector.read", { path: "new.ts" });
		expect(String(result.content)).toContain("x = 1");
	});

	it("lector.edit applies replacement", async () => {
		await drive(nerve, "lector.write", { path: "edit.ts", content: "const a = 1;" });
		await drive(nerve, "lector.edit", {
			path: "edit.ts",
			edits: [{ oldText: "const a = 1;", newText: "const a = 42;" }],
		});
		const result = await drive(nerve, "lector.read", { path: "edit.ts" });
		expect(String(result.content)).toContain("42");
	});

	it("lector.search returns matches", async () => {
		const result = await drive(nerve, "lector.search", { pattern: "logout" });
		const matches = result.matches as { path: string }[];
		expect(matches.some((m) => m.path === "auth.ts")).toBe(true);
	});

	it("lector.find returns file paths", async () => {
		const result = await drive(nerve, "lector.find", { glob: "*.ts" });
		const paths = result.paths as string[];
		expect(paths).toContain("auth.ts");
	});

	it("lector.callers returns call sites excluding declarations", async () => {
		const b = new StubLectorBackend({
			"auth.ts": AUTH_TS,
			"api.ts": "import { login } from './auth';\nlogin('user');\n",
		});
		const o = createLectorOrgan({ cwd: "/workspace", backend: b });
		const n = new InProcessNerve();
		o.mount(n.asNerve());

		const result = await drive(n, "lector.callers", { symbol: "login" });
		const callers = result.callers as { path: string }[];
		expect(callers.some((c) => c.path === "api.ts")).toBe(true);
	});

	it("sense event isError=true on missing file", async () => {
		const nerve2 = new InProcessNerve();
		const organ2 = createLectorOrgan({ cwd: "/workspace", backend });
		organ2.mount(nerve2.asNerve());

		const result = await new Promise<{ isError: boolean }>((resolve) => {
			const off = nerve2.asNerve().sense.subscribe("lector.read", (e) => {
				off();
				resolve(e);
			});
			nerve2.asNerve().motor.publish({
				type: "lector.read",
				payload: { path: "nonexistent.ts", toolCallId: "tc-2" },
				correlationId: "test",
				timestamp: Date.now(),
			});
		});
		expect(result.isError).toBe(true);
	});
});

describe("LectorOrgan — tool definitions", () => {
	it("exposes six tools by default", () => {
		const organ = createLectorOrgan({ cwd: "/workspace", backend: new StubLectorBackend() });
		const names = organ.tools.map((t) => t.name);
		expect(names).toContain("lector.read");
		expect(names).toContain("lector.write");
		expect(names).toContain("lector.edit");
		expect(names).toContain("lector.search");
		expect(names).toContain("lector.find");
		expect(names).toContain("lector.callers");
	});

	it("ablation: actions allowlist restricts tools", () => {
		const organ = createLectorOrgan({
			cwd: "/workspace",
			backend: new StubLectorBackend(),
			actions: ["lector.read", "lector.search", "lector.find"],
		});
		const names = organ.tools.map((t) => t.name);
		expect(names).toContain("lector.read");
		expect(names).not.toContain("lector.write");
		expect(names).not.toContain("lector.edit");
	});
});
