/**
 * MultiTurn evaluations — ToolLevel: ReadWrite
 * Multi-step conversations: agent proposes then implements, or recalls earlier context.
 */

import type { Evaluation } from "../evaluation.js";
import { all, fileContains, fileExists, replyContains } from "../referee.js";

const PROPOSAL_SEED = `
// Existing auth module — needs rate limiting added
export function login(username: string, password: string): boolean {
  return username.length > 0 && password.length >= 8;
}
`.trim();

const MEMO_SEED = `
export interface Config {
  host: string;
  port: number;
  maxConnections: number;
}
`.trim();

export const proposeFirst: Evaluation = {
	id: "ProposeFirst",
	toolLevel: "ReadWrite",
	template: "MultiTurn",
	seed: [{ path: "src/auth.ts", content: PROPOSAL_SEED }],
	prompt: [
		"Read src/auth.ts. Propose a plan to add rate limiting to the login function. " +
			"Describe your approach in 2-3 sentences. Do not write any code yet.",
		"Good. Now implement the rate limiting you described. Edit src/auth.ts.",
	],
	mustUse: ["fs.read"],
	referee: all(fileContains("src/auth.ts", "rate", "login")),
};

export const memoRecall: Evaluation = {
	id: "MemoRecall",
	toolLevel: "ReadOnly",
	template: "MultiTurn",
	seed: [{ path: "src/config.ts", content: MEMO_SEED }],
	prompt: [
		"Read src/config.ts. What is the type of the maxConnections field?",
		"Using that information — what TypeScript type would a valid Config object literal be?",
	],
	mustUse: ["fs.read"],
	mustNotUse: ["fs.write", "fs.edit"],
	referee: replyContains("number"),
};

export const approveProposal: Evaluation = {
	id: "ApproveProposal",
	toolLevel: "ReadWrite",
	template: "MultiTurn",
	prompt: [
		"I need a utility function that truncates a string to N characters and appends '...' " +
			"if it was truncated. What function signature would you propose?",
		"Good. Create src/truncate.ts implementing that function.",
	],
	referee: all(fileExists("src/truncate.ts"), fileContains("src/truncate.ts", "...")),
};
