# Alf Agent monorepo — convenience targets over npm scripts.
#
# Tooling (best-practice alignment):
#   - Formatter + linter: Biome (`biome.json`). Canonical gate: `npm run check`
#     (Biome with --write, tsgo --noEmit, browser smoke, web-ui check).
#   - Pre-commit: Husky `.husky/pre-commit` runs `npm run check` and may run
#     `check:browser-smoke` when relevant paths are staged.
#   - Install hooks: `npm install` runs `prepare` → `husky`. Use `make hooks`
#     if you cloned before hooks existed.
#
# CI tip: prefer `npm ci` over `npm install` for reproducible installs.
#
# Global CLI: `make install` builds packages and runs `npm install -g ./packages/coding-agent`,
# placing `alf` in `$(npm prefix -g)/bin` (often ~/.local/bin). Requires Node/npm on PATH.
#
# Variables (override on CLI: `make check NPM=npm`):
NPM ?= npm

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this list
	@printf '%s\n' "Typical targets (see package.json for full scripts):"
	@grep -E '^[a-zA-Z][a-zA-Z0-9_-]*:.*##' "$(firstword $(MAKEFILE_LIST))" | \
		sort | \
		awk 'BEGIN {FS = ":.*## "}; {printf "  %-22s %s\n", $$1, $$2}'

.PHONY: install-deps install-global install
install-deps: ## Install Node dependencies only (npm install; runs Husky prepare)
	$(NPM) install

install-global: build ## Build all packages and install alf into npm global bin
	$(NPM) install -g ./packages/coding-agent

install: install-deps install-global ## Install deps, build, and install alf globally (`npm install -g`)

.PHONY: ci
ci: ## Install dependencies for CI (npm ci)
	$(NPM) ci

.PHONY: hooks
hooks: ## (Re)install Husky Git hooks via npm prepare
	$(NPM) run prepare

.PHONY: clean
clean: ## Remove build outputs in workspaces
	$(NPM) run clean

.PHONY: build
build: ## Build all packages (order: tui, ai, agent, coding-agent, web-ui)
	$(NPM) run build

.PHONY: check
check: ## Lint, format, typecheck — same as Husky pre-commit main step
	$(NPM) run check

.PHONY: check-browser-smoke
check-browser-smoke: ## Browser smoke script only
	$(NPM) run check:browser-smoke

.PHONY: test
test: ## Run tests in all workspaces that define a test script
	$(NPM) run test

.PHONY: alf
alf: ## Run Alf from source (./alf-test.sh)
	./alf-test.sh

.PHONY: dev
dev: ## Start package dev watchers (long-running)
	$(NPM) run dev

.PHONY: verify
verify: ## Strong local gate: npm ci + build + check (single recipe; safe with make -j)
	$(NPM) ci
	$(NPM) run build
	$(NPM) run check
