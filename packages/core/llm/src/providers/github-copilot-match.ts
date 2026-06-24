import type { Api, Model } from "../types.js";

export function matchesGitHubCopilot(model: Model<Api>): boolean {
	return model.provider === "github-copilot";
}
