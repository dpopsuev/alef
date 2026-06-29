/**
 * Golden snapshot tests for TUI components.
 *
 * Run normally:   npx tsx ../../node_modules/vitest/dist/cli.js --run test/golden.test.ts
 * Update golden:  GOLDEN_UPDATE=1 npx tsx ../../node_modules/vitest/dist/cli.js --run test/golden.test.ts
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { renderToolLine } from "../src/client/mode.js";
import { rasterise, rasterToBlocks } from "../src/client/raster.js";
import { getTheme } from "../src/client/theme.js";
import { goldenPath, requireGolden, stripANSI } from "./golden.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const g = (name: string, got: string) => requireGolden(name, got, __dir);

const LATIN_FONT = "/usr/share/fonts/liberation-sans-fonts/LiberationSans-Regular.ttf";
const MAG = "\x1b[35m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

describe("Tool lines", { tags: ["unit"] }, () => {
	it("active tool line", () => {
		g("tool_active", renderToolLine("fs.read", "README.md", 0, true, getTheme()));
	});

	it("successful tool line", () => {
		g("tool_ok", renderToolLine("fs.read", "README.md", 42, true, getTheme()));
	});

	it("failed tool line", () => {
		g("tool_err", renderToolLine("shell.exec", "npm test", 1800, false, getTheme()));
	});

	it("tool line without key arg", () => {
		g("tool_no_arg", renderToolLine("fs.find", "", 15, true, getTheme()));
	});
});

describe("ANSI stripping", { tags: ["unit"] }, () => {
	it("strips color codes", () => {
		const stripped = stripANSI(`${BOLD}${MAG}hello${RESET} world`);
		g("ansi_stripped", stripped);
	});

	it("passes plaintext unchanged", () => {
		g("ansi_plain", stripANSI("no escapes here"));
	});
});

describe("Block element glyph rendering", { tags: ["unit"] }, () => {
	it("renders letter A at 64pt", async () => {
		const pixels = await rasterise("A", LATIN_FONT, 64);
		if (!pixels) throw new Error("rasterise returned null for A");
		const art = rasterToBlocks(
			pixels,
			(ch) => `${BOLD}${MAG}${ch}${RESET}`,
			(ch) => `${MAG}${ch}${RESET}`,
			(ch) => `${DIM}${MAG}${ch}${RESET}`,
		);
		g("glyph_A_64pt", art);
	});

	it("renders letter O at 64pt — symmetry check", async () => {
		const pixels = await rasterise("O", LATIN_FONT, 64);
		if (!pixels) throw new Error("rasterise returned null for O");
		const art = rasterToBlocks(
			pixels,
			(ch) => `${BOLD}${MAG}${ch}${RESET}`,
			(ch) => `${MAG}${ch}${RESET}`,
			(ch) => `${DIM}${MAG}${ch}${RESET}`,
		);
		g("glyph_O_64pt", art);
	});
});

// ---------------------------------------------------------------------------
// Golden path helper self-tests
// ---------------------------------------------------------------------------
describe("Golden infrastructure", { tags: ["unit"] }, () => {
	it("goldenPath derives from test name", () => {
		const path = goldenPath("my_test_name", "/some/dir");
		if (!path.endsWith("testdata/my_test_name.golden")) {
			throw new Error(`Unexpected path: ${path}`);
		}
	});

	it("stripANSI handles empty string", () => {
		if (stripANSI("") !== "") throw new Error("Expected empty string");
	});

	it("stripANSI handles OSC sequences", () => {
		const with_osc = "\x1b]0;window title\x07plain";
		if (stripANSI(with_osc) !== "plain") {
			throw new Error(`Expected 'plain', got: ${stripANSI(with_osc)}`);
		}
	});
});
