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
			/**
			 * Override context window size in tokens for synthetic/unlisted models.
			 * Registry models use their published contextWindow; this only applies
			 * when the model is not in the static registry (custom routes, local models).
			 */
			contextWindow: z.number().int().min(1024).optional(),
		})
		.optional(),

	you: z.string().optional(),
	agent: z.string().optional(),

	/**
	 * Tool execution permissions.
	 * allowed_tools: list of tool event types permitted without prompting.
	 * Omit or set to [] to allow nothing (deny-all).
	 * Set to ["*"] to allow everything (same effect as --yolo).
	 */
	permissions: z
		.object({
			allowed_tools: z.array(z.string()).optional(),
		})
		.optional(),

	/**
	 * Filesystem security — OCAP grants injected into organs via DI.
	 *
	 * writable_roots: directories organs are allowed to read/write.
	 *   Supports "${cwd}" (resolved at boot) and "${tmpdir}" (os.tmpdir()).
	 *   Default (omitted): unrestricted — organs can access any path.
	 *   Empty []: cwd only (most restrictive).
	 *
	 * Examples:
	 *   security: { writable_roots: ["${cwd}", "${tmpdir}"] }  # workspace + tmp
	 *   security: { writable_roots: ["${cwd}"] }               # workspace only
	 *   # omit security section entirely for unrestricted (pi-mono style)
	 */
	security: z
		.object({
			writable_roots: z.array(z.string()).optional(),
		})
		.optional(),

	/** Skills organ configuration. */
	skills: z
		.object({
			paths: z.array(z.string()).optional(),
		})
		.optional(),

	/**
	 * Model scope profiles — pre-configured subsets of allowed models.
	 *
	 * Each profile defines provider + model filters. On boot, only matching
	 * models appear in the :model picker and are usable via the API.
	 *
	 * providers: list of provider names (must exist in the model registry)
	 * models: optional list of model ID patterns (glob or exact match)
	 * default: model ID to select on boot (must match a profile entry)
	 */
	profiles: z
		.record(
			z.string(),
			z.object({
				providers: z.array(z.string()),
				models: z.array(z.string()).optional(),
				default: z.string().optional(),
				tiers: z
					.object({
						strong: z.string().optional(),
						default: z.string().optional(),
						fast: z.string().optional(),
					})
					.optional(),
			}),
		)
		.optional(),

	/** Active profile name — selects which profile to apply on boot. */
	profile: z.string().optional(),
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
