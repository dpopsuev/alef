import { describe, expect, it } from "vitest";
import { StubLectorBackend } from "../src/stub-backend.js";

const AUTH_TS = `export function login(user: string): boolean {
  return user.length > 0;
}

export function logout(): void {}

export class AuthService {
  login(u: string) { return login(u); }
}
`;

const API_TS = `import { login } from "./auth";

export async function callApi() {
  login("admin");
}
`;

describe("StubLectorBackend — read", () => {
	it("reads injected file", async () => {
		const b = new StubLectorBackend({ "auth.ts": AUTH_TS });
		const result = await b.read("auth.ts");
		expect(result.content).toBe(AUTH_TS.slice(0, 2000));
		expect(result.path).toBe("auth.ts");
		expect(result.totalLines).toBeGreaterThan(0);
	});

	it("throws for unknown path", async () => {
		const b = new StubLectorBackend();
		await expect(b.read("missing.ts")).rejects.toThrow(/not found/);
	});

	it("returns symbols on every read", async () => {
		const b = new StubLectorBackend({ "auth.ts": AUTH_TS });
		const result = await b.read("auth.ts");
		const names = result.symbols.map((s) => s.name);
		expect(names).toContain("login");
		expect(names).toContain("logout");
	});

	it("zooms into a symbol block", async () => {
		const b = new StubLectorBackend({ "auth.ts": AUTH_TS });
		const result = await b.read("auth.ts", { symbol: "logout" });
		expect(result.content).toContain("logout");
		expect(result.content).not.toContain("login(user");
	});

	it("throws when zoomed symbol does not exist", async () => {
		const b = new StubLectorBackend({ "auth.ts": AUTH_TS });
		await expect(b.read("auth.ts", { symbol: "missing" })).rejects.toThrow(/not found/);
	});

	it("respects offset", async () => {
		const b = new StubLectorBackend({ "f.ts": "line1\nline2\nline3\n" });
		const result = await b.read("f.ts", { offset: 2 });
		expect(result.content).toContain("line2");
		expect(result.content).not.toContain("line1");
	});

	it("truncates at maxLines", async () => {
		const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
		const b = new StubLectorBackend({ "f.ts": content });
		const result = await b.read("f.ts", { maxLines: 3 });
		expect(result.truncated).toBe(true);
		expect(result.content.split("\n")).toHaveLength(3);
	});
});

describe("StubLectorBackend — write / edit", () => {
	it("write creates a new file", async () => {
		const b = new StubLectorBackend();
		await b.write("new.ts", "export const x = 1;");
		const result = await b.read("new.ts");
		expect(result.content).toBe("export const x = 1;");
	});

	it("write overwrites existing file", async () => {
		const b = new StubLectorBackend({ "f.ts": "old" });
		await b.write("f.ts", "new");
		expect((await b.read("f.ts")).content).toBe("new");
	});

	it("edit replaces unique occurrence", async () => {
		const b = new StubLectorBackend({ "f.ts": "hello world" });
		await b.edit("f.ts", [{ oldText: "world", newText: "universe" }]);
		expect((await b.read("f.ts")).content).toBe("hello universe");
	});

	it("edit throws when oldText not found", async () => {
		const b = new StubLectorBackend({ "f.ts": "hello world" });
		await expect(b.edit("f.ts", [{ oldText: "missing", newText: "x" }])).rejects.toThrow(/not found/);
	});

	it("edit throws when oldText not unique", async () => {
		const b = new StubLectorBackend({ "f.ts": "foo foo" });
		await expect(b.edit("f.ts", [{ oldText: "foo", newText: "bar" }])).rejects.toThrow(/not unique/);
	});

	it("edit applies multiple edits in order", async () => {
		const b = new StubLectorBackend({ "f.ts": "a b c" });
		await b.edit("f.ts", [
			{ oldText: "a", newText: "A" },
			{ oldText: "c", newText: "C" },
		]);
		expect((await b.read("f.ts")).content).toBe("A b C");
	});
});

describe("StubLectorBackend — search", () => {
	it("finds pattern across files", async () => {
		const b = new StubLectorBackend({ "auth.ts": AUTH_TS, "api.ts": API_TS });
		const matches = await b.search("login");
		expect(matches.length).toBeGreaterThan(0);
		expect(matches.some((m) => m.path === "auth.ts")).toBe(true);
	});

	it("case-insensitive search", async () => {
		const b = new StubLectorBackend({ "f.ts": "Hello World" });
		const matches = await b.search("hello", { caseInsensitive: true });
		expect(matches.length).toBeGreaterThan(0);
	});

	it("respects extension filter", async () => {
		const b = new StubLectorBackend({ "a.ts": "login", "b.js": "login" });
		const matches = await b.search("login", { extension: "ts" });
		expect(matches.every((m) => m.path.endsWith(".ts"))).toBe(true);
	});

	it("returns line numbers", async () => {
		const b = new StubLectorBackend({ "f.ts": "line1\nlogin\nline3" });
		const matches = await b.search("login");
		expect(matches[0].line).toBe(2);
	});
});

describe("StubLectorBackend — find", () => {
	it("finds files by extension glob", async () => {
		const b = new StubLectorBackend({ "a.ts": "", "b.ts": "", "c.js": "" });
		const paths = await b.find("*.ts");
		expect(paths).toContain("a.ts");
		expect(paths).toContain("b.ts");
		expect(paths).not.toContain("c.js");
	});

	it("respects maxResults", async () => {
		const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}.ts`, ""]));
		const b = new StubLectorBackend(files);
		const paths = await b.find("*.ts", { maxResults: 3 });
		expect(paths).toHaveLength(3);
	});
});

describe("StubLectorBackend — callers", () => {
	it("returns call sites, excluding declarations", async () => {
		const b = new StubLectorBackend({ "auth.ts": AUTH_TS, "api.ts": API_TS });
		const callers = await b.callers("login");
		// auth.ts has the declaration + method call; api.ts has a call
		const paths = callers.map((c) => c.path);
		expect(paths).toContain("api.ts");
	});

	it("returns empty array for unknown symbol", async () => {
		const b = new StubLectorBackend({ "f.ts": "export function foo() {}" });
		const callers = await b.callers("nonexistent");
		expect(callers).toHaveLength(0);
	});
});
