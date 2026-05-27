import { homedir } from "node:os";
import { join } from "node:path";
import { getModel } from "@dpopsuev/alef-ai";
import { createAgentHarness } from "../../src/harness/factory.js";
import { NodeExecutionEnv } from "../../src/harness/nodejs-env.js";
import { loadSourcedPromptTemplates } from "../../src/harness/prompt-templates.js";
import { Session } from "../../src/harness/session/session.js";
import { InMemorySessionStorage } from "../../src/harness/session/storage/memory.js";
import { loadSourcedSkills } from "../../src/harness/skills.js";
import { formatSkillsForSystemPrompt } from "../../src/harness/system-prompt.js";

type Source = { type: "project" | "user" | "path"; dir: string };

const env = new NodeExecutionEnv({ cwd: process.cwd() });
const source = (type: Source["type"], dir: string) => ({ path: dir, source: { type, dir } });
const { skills: sourcedSkills } = await loadSourcedSkills<Source>(env, [
	source("project", join(env.cwd, ".alef/skills")),
	source("user", join(homedir(), ".alef/agent/skills")),
	source("path", join(env.cwd, "../../../pi-skills")),
]);
const { promptTemplates: sourcedPromptTemplates } = await loadSourcedPromptTemplates<Source>(env, [
	source("project", join(env.cwd, ".alef/prompts")),
	source("user", join(homedir(), ".alef/agent/prompts")),
]);

const session = new Session(new InMemorySessionStorage());
const agent = createAgentHarness({
	env,
	session,
	model: getModel("openai", "gpt-5.5"),
	thinkingLevel: "low",
	systemPrompt: ({ env, resources }) =>
		[
			"You are a helpful assistant.",
			formatSkillsForSystemPrompt(resources.skills ?? []),
			`Current working directory: ${env.cwd}`,
		]
			.filter((part) => part.length > 0)
			.join("\n\n"),
	resources: {
		promptTemplates: sourcedPromptTemplates.map(({ promptTemplate }) => promptTemplate),
		skills: sourcedSkills.map(({ skill }) => skill),
	},
});

const response = await agent.prompt("What skills do you have? Any duplicates?");
console.log(response);
