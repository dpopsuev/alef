import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
	splash: z
		.object({
			lang: z.string().optional(),
		})
		.optional(),

	theme: z
		.object({
			name: z.string().optional(),
			colors: z.record(z.string(), z.string()).optional(),
			background_opacity: z.number().min(0).max(1).optional(),
		})
		.optional(),

	model: z.string().optional(),

	thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),

	llm: z
		.object({
			/** Max retry attempts on transient provider errors. Default: 4. */
			maxRetries: z.number().int().min(0).optional(),
			/** Cap on retry delay in ms. Default: 8000. */
			maxRetryDelayMs: z.number().int().min(0).optional(),
			/** Per-request timeout in ms. Default: 60000. */
			timeoutMs: z.number().int().min(0).optional(),
		})
		.optional(),

	you: z.string().optional(),
	agent: z.string().optional(),
});

export type AlefConfig = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// XDG path resolution
// ---------------------------------------------------------------------------

function configPath(): string {
	const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	return join(base, "alef", "config.yaml");
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

let _config: AlefConfig | null = null;

export function loadConfig(): AlefConfig {
	if (_config) return _config;

	const path = configPath();
	if (!existsSync(path)) {
		_config = {};
		return _config;
	}

	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = parseYaml(raw) as unknown;
		const result = ConfigSchema.safeParse(parsed ?? {});
		if (!result.success) {
			process.stderr.write(
				`[alef] config parse error (${path}): ${result.error.issues.map((i) => i.message).join(", ")}\n`,
			);
			_config = {};
		} else {
			_config = result.data;
		}
	} catch (e) {
		process.stderr.write(`[alef] config load error: ${String(e)}\n`);
		_config = {};
	}

	return _config;
}

export function getConfig(): AlefConfig {
	return _config ?? loadConfig();
}

export { configPath };
