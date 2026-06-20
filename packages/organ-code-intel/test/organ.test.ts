import { InProcessNerve } from "@dpopsuev/alef-kernel";
import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { beforeEach, describe, expect, it } from "vitest";
import { createCodeIntelOrgan } from "../src/organ.js";
import { StubLectorBackend } from "../src/stub-backend.js";

organComplianceSuite(() => createCodeIntelOrgan({ cwd: process.cwd() }));

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
		});
	});
}

describe("LectorOrgan — motor/sense contract", { tags: ["compliance"] }, () => {
	let backend: StubLectorBackend;
	let nerve: InProcessNerve;

	beforeEach(() => {
		backend = new StubLectorBackend({ "auth.ts": AUTH_TS });
		const organ = createCodeIntelOrgan({ cwd: "/workspace", backend });
		nerve = new InProcessNerve();
		organ.mount(nerve.asNerve());
	});

	it("code.read returns content and symbols", async () => {
		const result = await drive(nerve, "code.read", { path: "auth.ts" });
		expect(typeof result.content).toBe("string");
		const symbols = result.symbols as { name: string }[];
		expect(symbols.some((s) => s.name === "login")).toBe(true);
	});

	it("code.read with symbol zooms into the block", async () => {
		const result = await drive(nerve, "code.read", { path: "auth.ts", symbol: "logout" });
		expect(String(result.content)).toContain("logout");
		expect(String(result.content)).not.toContain("login(user");
	});

	it("code.write persists content", async () => {
		await drive(nerve, "code.write", { path: "new.ts", content: "export const x = 1;" });
		const result = await drive(nerve, "code.read", { path: "new.ts" });
		expect(String(result.content)).toContain("x = 1");
	});

	it("code.edit applies replacement", async () => {
		await drive(nerve, "code.write", { path: "edit.ts", content: "const a = 1;" });
		await drive(nerve, "code.edit", {
			path: "edit.ts",
			edits: [{ oldText: "const a = 1;", newText: "const a = 42;" }],
		});
		const result = await drive(nerve, "code.read", { path: "edit.ts" });
		expect(String(result.content)).toContain("42");
	});

	it("code.search returns matches", async () => {
		const result = await drive(nerve, "code.search", { pattern: "logout" });
		const matches = result.matches as { path: string }[];
		expect(matches.some((m) => m.path === "auth.ts")).toBe(true);
	});

	it("code.find returns file paths", async () => {
		const result = await drive(nerve, "code.find", { glob: "*.ts" });
		const paths = result.paths as string[];
		expect(paths).toContain("auth.ts");
	});

	it("code.callers returns call sites excluding declarations", async () => {
		const b = new StubLectorBackend({
			"auth.ts": AUTH_TS,
			"api.ts": "import { login } from './auth';\nlogin('user');\n",
		});
		const o = createCodeIntelOrgan({ cwd: "/workspace", backend: b });
		const n = new InProcessNerve();
		o.mount(n.asNerve());

		const result = await drive(n, "code.callers", { symbol: "login" });
		const callers = result.callers as { path: string }[];
		expect(callers.some((c) => c.path === "api.ts")).toBe(true);
	});

	it("sense event isError=true on missing file", async () => {
		const nerve2 = new InProcessNerve();
		const organ2 = createCodeIntelOrgan({ cwd: "/workspace", backend });
		organ2.mount(nerve2.asNerve());

		const result = await new Promise<{ isError: boolean }>((resolve) => {
			const off = nerve2.asNerve().sense.subscribe("code.read", (e) => {
				off();
				resolve(e);
			});
			nerve2.asNerve().motor.publish({
				type: "code.read",
				payload: { path: "nonexistent.ts", toolCallId: "tc-2" },
				correlationId: "test",
			});
		});
		expect(result.isError).toBe(true);
	});
});

describe("LectorOrgan — tool definitions", { tags: ["compliance"] }, () => {
	it("exposes six tools by default", () => {
		const organ = createCodeIntelOrgan({ cwd: "/workspace", backend: new StubLectorBackend() });
		const names = organ.tools.map((t) => t.name);
		expect(names).toContain("code.read");
		expect(names).toContain("code.write");
		expect(names).toContain("code.edit");
		expect(names).toContain("code.search");
		expect(names).toContain("code.find");
		expect(names).toContain("code.callers");
	});

	it("ablation: actions allowlist restricts tools", () => {
		const organ = createCodeIntelOrgan({
			cwd: "/workspace",
			backend: new StubLectorBackend(),
			actions: ["code.read", "code.search", "code.find"],
		});
		const names = organ.tools.map((t) => t.name);
		expect(names).toContain("code.read");
		expect(names).not.toContain("code.write");
		expect(names).not.toContain("code.edit");
	});
});
