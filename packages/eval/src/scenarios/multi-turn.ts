/**
 * MultiTurn scenarios — multiple dialog.send() calls in one run.
 * Tests history accumulation, context retention, proposal/approval flow.
 */

import type { ScenarioContext } from "../harness.js";

/**
 * ProposeFirst — agent proposes a plan before acting.
 * Turn 1: ask agent to propose (not implement yet).
 * Turn 2: approve and ask to implement.
 * Pass: file exists after turn 2.
 */
export async function proposeFirst(ctx: ScenarioContext): Promise<void> {
	// Turn 1: agent proposes
	const proposal = await ctx.send(
		"I want a utility function that deep-clones a plain JS object. " +
			"Before writing any code, briefly describe your implementation approach in 2-3 sentences.",
	);

	const lower = proposal.toLowerCase();
	const isProposal =
		lower.includes("clone") ||
		lower.includes("object") ||
		lower.includes("json") ||
		lower.includes("recursive") ||
		lower.includes("structuredclone") ||
		lower.includes("implement");
	if (!isProposal) {
		throw new Error("Agent did not propose an approach in turn 1");
	}

	// Turn 2: approve and implement
	await ctx.send("Good. Now implement it in src/clone.ts. Export the function as 'deepClone'.");

	const content = await ctx.readFile("src/clone.ts");
	if (!content.includes("deepClone")) {
		throw new Error("deepClone not exported from src/clone.ts after approval");
	}
}

/**
 * MemoRecall — agent uses information from an earlier turn in a later turn.
 * Turn 1: tell agent a specific value.
 * Turn 2: ask agent to use that value in a file it creates.
 * Pass: file contains the specific value from turn 1.
 */
export async function memoRecall(ctx: ScenarioContext): Promise<void> {
	const MAGIC = "PORT_8421";

	// Turn 1: plant the value
	const ack = await ctx.send(
		`Remember this for later: the server should listen on port 8421. The configuration key is ${MAGIC}.`,
	);
	// Agent should acknowledge
	if (!ack || ack.trim().length < 5) {
		throw new Error("Agent did not acknowledge the information");
	}

	// Turn 2: ask agent to use the value
	await ctx.send("Now create src/config.ts. Export a const DEFAULT_PORT with the port number I mentioned earlier.");

	const content = await ctx.readFile("src/config.ts");
	if (!content.includes("8421")) {
		throw new Error("Agent did not recall port 8421 from earlier turn");
	}
	if (!content.includes("DEFAULT_PORT")) {
		throw new Error("DEFAULT_PORT not exported from src/config.ts");
	}
}

/**
 * ApproveProposal — agent asks for clarification, human provides it, agent proceeds.
 * Turn 1: vague request — agent should ask or clarify.
 * Turn 2: clarification provided — agent implements.
 * Pass: file exists and matches the clarification.
 */
export async function approveProposal(ctx: ScenarioContext): Promise<void> {
	// Turn 1: give a vague request that needs a decision
	const turn1 = await ctx.send(
		"Create a sorting utility in src/sort.ts. " +
			"I'm not sure if I want ascending or descending order as the default. " +
			"What would you recommend and why? Don't write any code yet.",
	);

	// Agent should respond with a recommendation
	const lower = turn1.toLowerCase();
	const hasRecommendation =
		lower.includes("ascend") ||
		lower.includes("descend") ||
		lower.includes("recommend") ||
		lower.includes("suggest") ||
		lower.includes("default") ||
		lower.includes("sort");
	if (!hasRecommendation) {
		throw new Error("Agent did not make a recommendation in turn 1");
	}

	// Turn 2: accept and provide direction
	await ctx.send(
		"Good point. Go with ascending as default. Implement sortArray in src/sort.ts. " +
			"It should accept an array of numbers and an optional 'direction' param ('asc' | 'desc'). " +
			"Export sortArray.",
	);

	const content = await ctx.readFile("src/sort.ts");
	if (!content.includes("sortArray")) {
		throw new Error("sortArray not found in src/sort.ts");
	}
	if (!content.includes("asc") || !content.includes("desc")) {
		throw new Error("direction parameter not implemented");
	}
}
