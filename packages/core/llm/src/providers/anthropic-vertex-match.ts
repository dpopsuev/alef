import type { Api, Model } from "../types.js";

function hasVertexConfig(): boolean {
	if (typeof process === "undefined") return false;
	const projectId =
		process.env.ANTHROPIC_VERTEX_PROJECT_ID?.trim() ||
		process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
		process.env.GCLOUD_PROJECT?.trim();
	const region = process.env.CLOUD_ML_REGION?.trim() || process.env.GOOGLE_CLOUD_LOCATION?.trim();
	return Boolean(projectId && region);
}

export function matchesAnthropicVertex(model: Model<Api>): boolean {
	return model.provider === "anthropic" && hasVertexConfig();
}
