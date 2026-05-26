import tseslint from "typescript-eslint";

export default tseslint.config(
	// Type-aware rules on production source only.
	// Tests are excluded — payload access patterns there are intentional fixtures.
	{
		files: ["packages/*/src/**/*.ts"],
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
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
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

			// ── Known debt: payload narrowing — will be fixed with getString/getNumber helpers ──
			// Fires on String(ctx.payload.x ?? '') where payload field is unknown.
			"@typescript-eslint/no-base-to-string": "warn",

			// ── Unused vars: ignore _ prefix (TypeScript convention) ─────────────
			"@typescript-eslint/no-unused-vars": ["error", {
				varsIgnorePattern: "^_",
				argsIgnorePattern: "^_",
				caughtErrorsIgnorePattern: "^_",
			}],

			// ── Rules from recommendedTypeChecked we relax ────────────────────────
			// We use as-casts deliberately at API boundaries — flag but don't block.
			"@typescript-eslint/consistent-type-assertions": ["warn", {
				assertionStyle: "as",
				objectLiteralTypeAssertions: "allow-as-parameter",
			}],
			// Enforce top-level imports — no import("pkg").Type in type positions (AGENTS.md).
			"@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports", fixStyle: "inline-type-imports" }],
			"@typescript-eslint/no-import-type-side-effects": "error",
			// Empty interfaces are used for future extension points — Biome checks this.
			"@typescript-eslint/no-empty-object-type": "off",
			// Unbound methods are intentional in EDA subscriber patterns.
			"@typescript-eslint/unbound-method": "off",
			// prefer-promise-reject-errors is enforced but rejection values are already Error instances.
			"@typescript-eslint/prefer-promise-reject-errors": "warn",
			// We have intentional any-typed interop at external API boundaries.
			"@typescript-eslint/no-explicit-any": "off",
			// Inline type narrowing helpers are a refactor, not a lint error yet.
			"@typescript-eslint/no-unsafe-call": "warn",
			// requiresTypeChecking rules that are noisy with Record<string,unknown>
			"@typescript-eslint/no-redundant-type-constituents": "off",
			"@typescript-eslint/no-unnecessary-type-assertion": "warn",
		},
	},
);
