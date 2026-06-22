import type { ColorToken } from "../tui/ansi.js";

export interface ProviderColor {
	token: ColorToken;
	label: string;
}

const PROVIDER_COLORS: Record<string, ProviderColor> = {
	anthropic: { label: "Anthropic", token: { truecolor: "#d97757", ansi256: 208, ansi16: 33 } },
	google: { label: "Google", token: { truecolor: "#4285F4", ansi256: 33, ansi16: 34 } },
	"google-vertex": { label: "Vertex", token: { truecolor: "#34A853", ansi256: 35, ansi16: 32 } },
	openai: { label: "OpenAI", token: { truecolor: "#10A37F", ansi256: 36, ansi16: 36 } },
	"amazon-bedrock": { label: "Bedrock", token: { truecolor: "#FF9900", ansi256: 214, ansi16: 33 } },
	groq: { label: "Groq", token: { truecolor: "#F55036", ansi256: 196, ansi16: 31 } },
	openrouter: { label: "OpenRouter", token: { truecolor: "#6366F1", ansi256: 99, ansi16: 35 } },
	mistral: { label: "Mistral", token: { truecolor: "#FF7000", ansi256: 202, ansi16: 33 } },
	xai: { label: "xAI", token: { truecolor: "#FFFFFF", ansi256: 255, ansi16: 37 } },
	cerebras: { label: "Cerebras", token: { truecolor: "#0066FF", ansi256: 27, ansi16: 34 } },
	deepseek: { label: "DeepSeek", token: { truecolor: "#4D6BFE", ansi256: 69, ansi16: 34 } },
	fireworks: { label: "Fireworks", token: { truecolor: "#FF6B35", ansi256: 209, ansi16: 33 } },
	together: { label: "Together", token: { truecolor: "#0A84FF", ansi256: 39, ansi16: 34 } },
	huggingface: { label: "HuggingFace", token: { truecolor: "#FFD21E", ansi256: 220, ansi16: 33 } },
};

const FALLBACK: ProviderColor = { label: "Unknown", token: { ansi256: 245, ansi16: 37 } };

export function getProviderColor(provider: string): ProviderColor {
	return PROVIDER_COLORS[provider] ?? FALLBACK;
}

export function allProviderColors(): ReadonlyMap<string, ProviderColor> {
	return new Map(Object.entries(PROVIDER_COLORS));
}
