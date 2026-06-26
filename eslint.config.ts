import boundaries from "eslint-plugin-boundaries";
import tseslint from "typescript-eslint";

export default tseslint.config(
	// ── Runner intra-package import boundaries ──────────────────────────
	// Enforces a DAG: subdirectories can import root, root can import
	// subdirectories, but subdirectories cannot import each other
	// (except where explicitly allowed).
	{
		files: ["packages/runner/src/**/*.ts"],
		plugins: { boundaries },
		settings: {
			"import/resolver": {
				typescript: {
					project: "packages/runner/tsconfig.build.json",
				},
			},
			"boundaries/elements": [
				{ type: "model", pattern: ["model"] },
				{ type: "session-lifecycle", pattern: ["session-lifecycle"] },
				{ type: "tui", pattern: ["tui"] },
				{ type: "commands", pattern: ["commands"] },
				{ type: "identity", pattern: ["identity"] },
				{ type: "strategies", pattern: ["strategies"] },
				{ type: "workflow", pattern: ["workflow"] },
				{ type: "root", pattern: ["src/*"], mode: "file" },
			],
		},
		rules: {
			"boundaries/dependencies": ["error", {
				default: "disallow",
				rules: [
					{ from: { type: "root" }, allow: [{ to: { type: "root" } }, { to: { type: "model" } }, { to: { type: "session-lifecycle" } }, { to: { type: "tui" } }, { to: { type: "commands" } }, { to: { type: "identity" } }, { to: { type: "strategies" } }, { to: { type: "workflow" } }] },
					{ from: { type: "model" }, allow: [{ to: { type: "root" } }] },
					{ from: { type: "session-lifecycle" }, allow: [{ to: { type: "root" } }] },
					{ from: { type: "tui" }, allow: [{ to: { type: "root" } }, { to: { type: "commands" } }] },
					{ from: { type: "commands" }, allow: [{ to: { type: "root" } }, { to: { type: "model" } }, { to: { type: "tui" } }] },
					{ from: { type: "identity" }, allow: [{ to: { type: "root" } }] },
					{ from: { type: "strategies" }, allow: [{ to: { type: "root" } }] },
					{ from: { type: "workflow" }, allow: [{ to: { type: "root" } }] },
				],
			}],
		},
	},

	// Type-aware rules on production source only.
	// Tests are excluded — payload access patterns there are intentional fixtures.
	{
		files: ["packages/*/src/**/*.ts", "packages/*/*/src/**/*.ts"],
		ignores: [
			"**/node_modules/**",
			"**/dist/**",
			"**/models.generated.ts",
		],
		extends: [
			...tseslint.configs.recommendedTypeChecked,
		],
		languageOptions: {
			parserOptions: {
				project: "./tsconfig.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// ── No barrel imports ────────────────────────────────────────────────
			// Import from the source module, not index.ts re-exports.
			// Use subpath exports (e.g. @dpopsuev/alef-llm/provider-port).
			"no-restricted-imports": ["error", {
				patterns: [{
					group: ["../index", "../index.js", "../../index", "../../index.js"],
					message: "Do not import from barrel files (index.ts). Import from the source module directly.",
				}],
			}],

			// ── Void suppression ban ─────────────────────────────────────────────
			// Forbid `void expr` used to silence unused-variable warnings.
			// `void promise` for fire-and-forget is allowed as a statement.
			"no-void": ["error", { allowAsStatement: true }],

			// ── Rules we explicitly want ─────────────────────────────────────────
			// Catches accessing Record<string, unknown> fields without narrowing.
			"@typescript-eslint/no-unsafe-member-access": "error",
			// Catches passing unknown values to typed params without narrowing.
			"@typescript-eslint/no-unsafe-argument": "error",
			// Catches returning unknown without narrowing.
			"@typescript-eslint/no-unsafe-return": "error",
			// Catches assigning unknown without narrowing.
			"@typescript-eslint/no-unsafe-assignment": "warn",
			// Catches floating promises (void store.append() swallowing errors).
			"@typescript-eslint/no-floating-promises": "error",
			// Forces callback error variables to be typed as unknown.
			"@typescript-eslint/use-unknown-in-catch-callback-variable": "warn",

			// ── Anti-pattern: any abuse (AI agents' #1 escape hatch) ────────────
			"@typescript-eslint/no-explicit-any": "warn",
			"@typescript-eslint/no-unsafe-assignment": "warn",
			"@typescript-eslint/no-unsafe-call": "warn",
			"@typescript-eslint/no-unsafe-type-assertion": "error",

			// ── Anti-pattern: enum misuse ─────────────────────────────────────────
			"@typescript-eslint/no-unsafe-enum-comparison": "error",
			"@typescript-eslint/no-mixed-enums": "error",

			// ── Anti-pattern: truthy/falsy bugs ──────────────────────────────────
			"@typescript-eslint/prefer-nullish-coalescing": "error",
			"@typescript-eslint/no-unnecessary-condition": "error",

			// ── Anti-pattern: dead code / legacy ─────────────────────────────────
			"@typescript-eslint/no-namespace": "error",

			// ── Known debt: payload narrowing ────────────────────────────────────
			"@typescript-eslint/no-base-to-string": "warn",

			// ── Unused vars: ignore _ prefix (TypeScript convention) ─────────────
			"@typescript-eslint/no-unused-vars": ["error", {
				varsIgnorePattern: "^_",
				argsIgnorePattern: "^_",
				caughtErrorsIgnorePattern: "^_",
			}],

			// ── Type assertion hygiene ────────────────────────────────────────────
			"@typescript-eslint/consistent-type-assertions": ["warn", {
				assertionStyle: "as",
				objectLiteralTypeAssertions: "allow-as-parameter",
			}],
			"@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports", fixStyle: "inline-type-imports" }],
			"@typescript-eslint/no-import-type-side-effects": "error",
			"@typescript-eslint/no-unnecessary-type-assertion": "warn",

			// ── Relaxed: intentional patterns ────────────────────────────────────
			"@typescript-eslint/no-empty-object-type": "off",
			"@typescript-eslint/unbound-method": "off",
			"@typescript-eslint/prefer-promise-reject-errors": "warn",
			"@typescript-eslint/no-redundant-type-constituents": "off",
			"@typescript-eslint/use-unknown-in-catch-callback-variable": "warn",
		},
	},
);
