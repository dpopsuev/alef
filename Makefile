# Alef Agent monorepo — convenience targets over npm scripts.
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
# placing `alef` in `$(npm prefix -g)/bin` (often ~/.local/bin). Requires Node/npm on PATH.
#
# Variables (override on CLI: `make check NPM=npm`):
NPM ?= npm

# XDG Base Directory paths (with fallbacks)
XDG_CONFIG_HOME ?= $(HOME)/.config
XDG_DATA_HOME   ?= $(HOME)/.local/share
XDG_STATE_HOME  ?= $(HOME)/.local/state
XDG_CACHE_HOME  ?= $(HOME)/.cache

# Alef XDG directories
ALEF_CONFIG_DIR = $(XDG_CONFIG_HOME)/alef
ALEF_DATA_DIR   = $(XDG_DATA_HOME)/alef
ALEF_STATE_DIR  = $(XDG_STATE_HOME)/alef
ALEF_CACHE_DIR  = $(XDG_CACHE_HOME)/alef

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this list
	@printf '%s\n' "Typical targets (see package.json for full scripts):"
	@grep -E '^[a-zA-Z][a-zA-Z0-9_-]*:.*##' "$(firstword $(MAKEFILE_LIST))" | \
		sort | \
		awk 'BEGIN {FS = ":.*## "}; {printf "  %-22s %s\n", $$1, $$2}'

.PHONY: install-deps install
install-deps: ## Install Node dependencies (npm install; runs Husky prepare)
	$(NPM) install

install: install-deps ## Install alef globally (no build step — runs from source via tsx)
	$(NPM) install -g ./packages/runner

.PHONY: run
run: ## Run alef from source (interactive TUI)
	npx tsx packages/runner/src/main.ts

run-serve: ## Run alef in HTTP/SSE serve mode on a random port
	npx tsx packages/runner/src/main.ts --serve 0


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

.PHONY: alef
alef: ## Run Alef from source (./alef-test.sh)
	./alef-test.sh

# ---------------------------------------------------------------------------
# XDG and Debug targets
# ---------------------------------------------------------------------------

.PHONY: xdg-setup
xdg-setup: ## Setup XDG directory structure for Alef (run once)
	@echo "🔧 Setting up Alef XDG directories..."
	@bash scripts/setup-xdg.sh

.PHONY: xdg-info
xdg-info: ## Show current XDG paths and directory status
	@echo "📂 Alef XDG Directory Structure:"
	@echo ""
	@echo "  XDG_CONFIG_HOME = $(XDG_CONFIG_HOME)"
	@echo "  XDG_DATA_HOME   = $(XDG_DATA_HOME)"
	@echo "  XDG_STATE_HOME  = $(XDG_STATE_HOME)"
	@echo "  XDG_CACHE_HOME  = $(XDG_CACHE_HOME)"
	@echo ""
	@echo "  Alef Config:    $(ALEF_CONFIG_DIR)"
	@test -d "$(ALEF_CONFIG_DIR)" && echo "    ✓ exists" || echo "    ✗ not found (run 'make xdg-setup')"
	@echo "  Alef Data:      $(ALEF_DATA_DIR)"
	@test -d "$(ALEF_DATA_DIR)" && echo "    ✓ exists" || echo "    ✗ not found"
	@echo "  Alef State:     $(ALEF_STATE_DIR)"
	@test -d "$(ALEF_STATE_DIR)" && echo "    ✓ exists" || echo "    ✗ not found"
	@echo "  Alef Cache:     $(ALEF_CACHE_DIR)"
	@test -d "$(ALEF_CACHE_DIR)" && echo "    ✓ exists" || echo "    ✗ not found"
	@echo ""
	@echo "  Debug log:      $(ALEF_STATE_DIR)/debug.log"
	@test -f "$(ALEF_STATE_DIR)/debug.log" && echo "    ✓ exists ($$(du -h $(ALEF_STATE_DIR)/debug.log | cut -f1))" || echo "    ✗ not yet created"
	@echo "  Debug skill:    $(ALEF_CONFIG_DIR)/skills/debug-alef/SKILL.md"
	@test -f "$(ALEF_CONFIG_DIR)/skills/debug-alef/SKILL.md" && echo "    ✓ exists" || echo "    ✗ not found"

.PHONY: debug
debug: xdg-setup ## Run Alef in debug mode with diagnostic skills auto-loaded
	@echo "🐛 Starting Alef in DEBUG mode..."
	@echo ""
	@echo "  • XDG paths initialized"
	@echo "  • Log level: debug"
	@echo "  • Model: claude-sonnet-4-5 (with thinking)"
	@echo "  • LLM timeout: 2 minutes (120s)"
	@echo "  • Debug log: $(ALEF_STATE_DIR)/debug.log"
	@echo "  • Skills: debug-alef auto-loaded"
	@echo ""
	@echo "  Watch logs live:"
	@echo "    tail -f $(ALEF_STATE_DIR)/debug.log | jq ."
	@echo ""
	@ALEF_DEBUG=1 \
	ALEF_MODEL=claude-sonnet-4-5 \
	ALEF_LLM_TIMEOUT_MS=120000 \
	XDG_CONFIG_HOME=$(XDG_CONFIG_HOME) \
	XDG_DATA_HOME=$(XDG_DATA_HOME) \
	XDG_STATE_HOME=$(XDG_STATE_HOME) \
	XDG_CACHE_HOME=$(XDG_CACHE_HOME) \
	./alef-test.sh

.PHONY: debug-watch
debug-watch: ## Watch debug.log in real-time (requires jq)
	@echo "📊 Watching $(ALEF_STATE_DIR)/debug.log (Ctrl+C to stop)"
	@tail -f "$(ALEF_STATE_DIR)/debug.log" | jq .

.PHONY: debug-errors
debug-errors: ## Show only errors from debug.log
	@echo "⚠️  Errors from $(ALEF_STATE_DIR)/debug.log:"
	@jq 'select(.level >= 50) | {time, organ, tool, msg, err: .err.message}' "$(ALEF_STATE_DIR)/debug.log" 2>/dev/null || echo "No errors found or log doesn't exist"

.PHONY: debug-tools
debug-tools: ## Show tool execution timing from debug.log
	@echo "🔧 Tool execution summary:"
	@jq -r 'select(.msg == "tool:end") | "\(.name)\t\(.elapsedMs)ms\t\(if .ok then "✓" else "✗" end)"' "$(ALEF_STATE_DIR)/debug.log" 2>/dev/null | column -t -s $$'\t' || echo "No tool executions found or log doesn't exist"

.PHONY: debug-clean
debug-clean: ## Clear debug.log and session files
	@echo "🧹 Cleaning debug artifacts..."
	@rm -f "$(ALEF_STATE_DIR)/debug.log"
	@rm -f "$(ALEF_STATE_DIR)/daemon.json"
	@rm -f "$(ALEF_STATE_DIR)/last-session.json"
	@echo "  ✓ Cleaned state directory"

# ---------------------------------------------------------------------------
# Original targets (preserved)
# ---------------------------------------------------------------------------

.PHONY: dev
dev: ## Start package dev watchers (long-running)
	$(NPM) run dev

.PHONY: verify
verify: ## Strong local gate: npm ci + build + check (single recipe; safe with make -j)
	$(NPM) ci
	$(NPM) run build
	$(NPM) run check

.PHONY: test-canary
test-canary: ## Canary: boot runner + send Hello, assert non-empty reply (requires API key)
	cd packages/alef-coding-agent && ALEF_E2E_TESTS=1 npx vitest run --reporter=verbose --tags-filter=canary

.PHONY: test-real-llm
test-real-llm: ## Full real-LLM eval suite in alef-coding-agent (requires API key)
	cd packages/alef-coding-agent && npx vitest run --reporter=verbose --tags-filter=real-llm
