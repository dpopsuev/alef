import { describe, expect, it } from "vitest";
import { parseSymbolicInput } from "../src/core/symbolic-commands.js";

describe("parseSymbolicInput", () => {
	it("parses operator commands and legacy builtins", () => {
		expect(parseSymbolicInput(":model anthropic/claude-opus-4")).toMatchObject({
			kind: "operator_command",
			name: "model",
			args: "anthropic/claude-opus-4",
		});
		expect(parseSymbolicInput("/review")).toMatchObject({
			kind: "legacy_slash_command",
			name: "review",
			args: "",
		});
	});

	it("treats unknown slash prefixes as paths and empty sigils as plain text", () => {
		expect(parseSymbolicInput("/tmp/session.jsonl")).toMatchObject({
			kind: "path_literal",
			path: "/tmp/session.jsonl",
		});
		expect(parseSymbolicInput("/not-a-command")).toMatchObject({
			kind: "path_literal",
			path: "/not-a-command",
		});
		expect(parseSymbolicInput(":")).toMatchObject({
			kind: "text",
			raw: ":",
		});
		expect(parseSymbolicInput("@")).toMatchObject({
			kind: "text",
			raw: "@",
		});
	});

	it("parses shell, address, entity, binding, query, and path inputs", () => {
		expect(parseSymbolicInput("!!npm run check")).toMatchObject({
			kind: "shell",
			command: "npm run check",
			excludeFromContext: true,
		});
		expect(parseSymbolicInput("@root-agent inspect")).toMatchObject({
			kind: "entity_reference",
			entity: "root-agent",
			remainder: "inspect",
		});
		expect(parseSymbolicInput("#board.forum.topic.thread")).toMatchObject({
			kind: "address_reference",
			address: {
				boardId: "board",
				forumId: "forum",
				topicId: "topic",
				threadId: "thread",
			},
		});
		expect(parseSymbolicInput("$session current")).toMatchObject({
			kind: "binding_reference",
			name: "session",
			remainder: "current",
		});
		expect(parseSymbolicInput("?providers")).toMatchObject({
			kind: "query_reference",
			query: "providers",
		});
		expect(parseSymbolicInput("/tmp/session.jsonl")).toMatchObject({
			kind: "path_literal",
			path: "/tmp/session.jsonl",
		});
	});

	it("fails fast on malformed discourse addresses", () => {
		expect(() => parseSymbolicInput("#board..topic")).toThrow();
	});
});
