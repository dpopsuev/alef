import importX from "eslint-plugin-import-x";
import jsdoc from "eslint-plugin-jsdoc";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: ["**/*.d.ts", "**/*.generated.ts"] },

	// ── Cycle detection: blocks circular imports at commit time ──────────
	{
		files: ["packages/*/src/**/*.ts", "packages/*/*/src/**/*.ts"],
		ignores: ["**/node_modules/**", "**/dist/**", "**/*.generated.ts"],
		plugins: { "import-x": importX },
		settings: {
			"import-x/resolver": {
				typescript: { project: "./tsconfig.json" },
			},
		},
		rules: {
			"import-x/no-cycle": ["error", {
				maxDepth: 3,
				ignoreExternal: true,
			}],
		},
	},

	// ── JSDoc: require documentation on all exported symbols ────────────
	// Enforces JSDoc on exported functions, classes, interfaces, type
	// aliases, and enums. Set to "warn" — does not block CI, but surfaces
	// undocumented code in editor and lint output.
	{
		files: ["packages/*/src/**/*.ts", "packages/*/*/src/**/*.ts"],
		ignores: ["**/node_modules/**", "**/dist/**", "**/test/**"],
		plugins: { jsdoc },
		rules: {
			"jsdoc/require-jsdoc": ["error", {
				publicOnly: false,
				require: {
					FunctionDeclaration: true,
					MethodDefinition: false,
					ClassDeclaration: true,
					ArrowFunctionExpression: false,
					FunctionExpression: false,
				},
				contexts: [
					"ExportNamedDeclaration > TSInterfaceDeclaration",
					"ExportNamedDeclaration > TSTypeAliasDeclaration",
					"ExportNamedDeclaration > TSEnumDeclaration",
				],
			}],
		},
	},

	// ── No magic numbers in all core domain packages ────────────────────
	// Business-critical thresholds, timeouts, and priorities must be named.
	// Generated files excluded — they are data tables full of numeric literals.
	{
		files: ["packages/core/*/src/**/*.ts"],
		ignores: ["**/test/**", "**/*.generated.ts"],
		rules: {
			"no-magic-numbers": ["error", {
				ignore: [0, 1, -1, 2],
				ignoreArrayIndexes: true,
				ignoreDefaultValues: true,
				enforceConst: true,
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
			"@typescript-eslint/no-unsafe-assignment": "error",
			// Catches floating promises (void store.append() swallowing errors).
			"@typescript-eslint/no-floating-promises": "error",
			// Forces callback error variables to be typed as unknown.
			"@typescript-eslint/use-unknown-in-catch-callback-variable": "error",

			// ── Anti-pattern: any abuse (AI agents' #1 escape hatch) ────────────
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-unsafe-assignment": "error",
			"@typescript-eslint/no-unsafe-call": "error",
			"@typescript-eslint/no-unsafe-type-assertion": "error",

			// ── Anti-pattern: enum misuse ─────────────────────────────────────────
			"@typescript-eslint/no-unsafe-enum-comparison": "error",
			"@typescript-eslint/no-mixed-enums": "error",

			// ── Anti-pattern: truthy/falsy bugs ──────────────────────────────────
			"@typescript-eslint/prefer-nullish-coalescing": "error",
			"@typescript-eslint/no-unnecessary-condition": "error",

			// ── Anti-pattern: dead code / legacy ─────────────────────────────────
			"@typescript-eslint/no-namespace": "error",

			// ── Payload narrowing ────────────────────────────────────────────────
			"@typescript-eslint/no-base-to-string": "error",

			// ── Unused vars: ignore _ prefix (TypeScript convention) ─────────────
			"@typescript-eslint/no-unused-vars": ["error", {
				varsIgnorePattern: "^_",
				argsIgnorePattern: "^_",
				caughtErrorsIgnorePattern: "^_",
			}],

			// ── Type assertion hygiene ────────────────────────────────────────────
			"@typescript-eslint/consistent-type-assertions": ["error", {
				assertionStyle: "as",
				objectLiteralTypeAssertions: "allow-as-parameter",
			}],
			"@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports", fixStyle: "inline-type-imports" }],
			"@typescript-eslint/no-import-type-side-effects": "error",
			"@typescript-eslint/no-unnecessary-type-assertion": "error",

			// ── Relaxed: intentional patterns ────────────────────────────────────
			"@typescript-eslint/no-empty-object-type": "off",
			"@typescript-eslint/unbound-method": "off",
			"@typescript-eslint/prefer-promise-reject-errors": "error",
			"@typescript-eslint/no-redundant-type-constituents": "off",
		},
	},

	// ── Architectural boundary: core must not import tools ───────────────
	// Overrides the generic type-aware block above to merge barrel ban +
	// tool import ban into a single no-restricted-imports rule.
	// Must come AFTER the type-aware block so flat config override applies.
	{
		files: ["packages/core/*/src/**/*.ts"],
		rules: {
			"no-restricted-imports": ["error", {
				patterns: [
					{
						group: ["../index", "../index.js", "../../index", "../../index.js"],
						message: "Do not import from barrel files. Import from the source module directly.",
					},
					{
						group: ["@dpopsuev/alef-tool-*"],
						message: "Core packages must not import from tool packages. Use adapter contributions or injection instead.",
					},
				],
			}],
		},
	},

	// ── Ports-and-adapters: session/engine must not import alef-ai ────────
	{
		files: [
			"packages/core/session/src/**/*.ts",
			"packages/core/engine/src/**/*.ts",
		],
		rules: {
			"no-restricted-imports": ["error", {
				patterns: [
					{
						group: ["../index", "../index.js", "../../index", "../../index.js"],
						message: "Do not import from barrel files. Import from the source module directly.",
					},
					{
						group: ["@dpopsuev/alef-tool-*"],
						message: "Core packages must not import from tool packages. Use adapter contributions or injection instead.",
					},
					{
						group: ["@dpopsuev/alef-ai", "@dpopsuev/alef-ai/*"],
						message: "Session/engine ports must not import @dpopsuev/alef-ai. Use @dpopsuev/alef-kernel/content and inject LLM callbacks at the composition root.",
					},
				],
			}],
		},
	},

	// ── Architectural boundary: tools must not import other tools ────────
	// Each tool adapter is independent. Shared adapter infrastructure lives
	// in mcp-registry (exempted via ignores — those tools depend on it legitimately).
	{
		files: ["packages/tools/*/src/**/*.ts"],
		ignores: ["packages/tools/locus/src/**", "packages/tools/scribe/src/**"],
		rules: {
			"no-restricted-imports": ["error", {
				patterns: [
					{
						group: ["../index", "../index.js", "../../index", "../../index.js"],
						message: "Do not import from barrel files. Import from the source module directly.",
					},
					{
						group: ["@dpopsuev/alef-tool-*"],
						message: "Tool packages must not import other tools.",
					},
				],
			}],
		},
	},
);
