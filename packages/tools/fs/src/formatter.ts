import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const TIMEOUT_MS = 10_000;

async function hasDepInPackageJson(cwd: string, dep: string): Promise<boolean> {
	const pkgPath = join(cwd, "package.json");
	if (!existsSync(pkgPath)) return false;
	try {
		const text = await readFile(pkgPath, "utf-8");
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse returns unknown, narrowed to expected shape
		const pkg = JSON.parse(text) as Record<string, unknown>;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- package.json deps are objects
		const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) };
		return dep in deps;
	} catch {
		return false;
	}
}

function markerExists(cwd: string, ...names: string[]): boolean {
	return names.some((n) => existsSync(join(cwd, n)));
}

async function detectCommand(cwd: string, filePath: string): Promise<string[] | null> {
	const ext = extname(filePath).toLowerCase();

	if (markerExists(cwd, "biome.json", "biome.jsonc")) {
		return ["biome", "format", "--write", filePath];
	}

	if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".md"].includes(ext)) {
		if (await hasDepInPackageJson(cwd, "prettier")) {
			return ["prettier", "--write", filePath];
		}
	}

	if (ext === ".go" && markerExists(cwd, "go.mod")) {
		return ["gofmt", "-w", filePath];
	}

	if (ext === ".rs" && markerExists(cwd, "Cargo.toml")) {
		return ["rustfmt", filePath];
	}

	if (ext === ".py" && markerExists(cwd, "pyproject.toml", "ruff.toml", ".ruff.toml")) {
		return ["ruff", "format", filePath];
	}

	return null;
}

function run(cmd: string[], cwd: string): Promise<void> {
	return new Promise((resolve) => {
		const [bin, ...args] = cmd;
		if (!bin) {
			resolve();
			return;
		}
		const child = spawn(bin, args, { cwd, stdio: "ignore" });
		// lint-ignore: RAWTIMER formatter subprocess hard deadline
		const timer = setTimeout(() => {
			child.kill();
			resolve();
		}, TIMEOUT_MS);
		child.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
		child.once("error", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

/** Auto-detect and run the project's code formatter on a file (biome, prettier, gofmt, etc.). */
export async function runFormatter(cwd: string, absolutePath: string): Promise<void> {
	try {
		const cmd = await detectCommand(cwd, absolutePath);
		if (cmd) await run(cmd, cwd);
	} catch {
		/* formatter errors must never fail the tool call */
	}
}
