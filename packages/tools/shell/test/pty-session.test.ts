import { describe, it } from "vitest";

describe("persistent PTY session (c0ed)", () => {
	it.todo("cd persists across shell.exec calls");
	it.todo("env vars persist across shell.exec calls");
	it.todo("shell aliases persist across shell.exec calls");
	it.todo("background:true returns task handle immediately");
	it.todo("stall detection triggers on hung process");
	it.todo("each subagent gets its own PTY session");
	it.todo("session cleanup on adapter unmount");
});
