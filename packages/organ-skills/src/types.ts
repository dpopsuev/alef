export interface SkillFrontmatter {
	name: string;
	description: string;
	/** Appears in the user-invocable command palette. */
	"user-invocable"?: boolean;
	/** Exclude from model prompt (user-invocable only). */
	"disable-model-invocation"?: boolean;
	license?: string;
	compatibility?: string;
}

export interface Skill {
	name: string;
	description: string;
	userInvocable: boolean;
	disableModelInvocation: boolean;
	instructions: string;
	path: string;
}
