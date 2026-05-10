import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	detectInstallMethod,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	getUpdateInstruction,
} from "../src/config.js";

const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
const originalPath = process.env.PATH;
const originalPiPackageDir = process.env.ALF_PACKAGE_DIR;
let tempDir: string | undefined;

function setExecPath(value: string): void {
	Object.defineProperty(process, "execPath", {
		value,
		configurable: true,
	});
}

afterEach(() => {
	if (execPathDescriptor) {
		Object.defineProperty(process, "execPath", execPathDescriptor);
	}
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
	if (originalPiPackageDir === undefined) {
		delete process.env.ALF_PACKAGE_DIR;
	} else {
		process.env.ALF_PACKAGE_DIR = originalPiPackageDir;
	}
	if (tempDir) {
		chmodSync(tempDir, 0o700);
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function createNpmPrefixInstall(template = "alf-prefix-"): { prefix: string; packageDir: string } {
	const prefix = mkdtempSync(join(tmpdir(), template));
	const root = join(prefix, "lib", "node_modules");
	const scopeDir = join(root, "@alf-agent");
	const packageDir = join(scopeDir, "coding-agent");
	mkdirSync(packageDir, { recursive: true });
	tempDir = prefix;
	process.env.ALF_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { prefix, packageDir };
}

function createPnpmGlobalInstall(): { root: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "alf-pnpm-"));
	const binDir = join(temp, "bin");
	const root = join(temp, "pnpm", "global", "5", "node_modules");
	const packageDir = join(root, "@legacy-scope", "legacy-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), createFakePnpmScript(root));
	chmodSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.ALF_PACKAGE_DIR = packageDir;
	setExecPath(
		join(
			root,
			".pnpm",
			"@legacy-scope+legacy-coding-agent@0.0.0",
			"node_modules",
			"@legacy-scope",
			"legacy-coding-agent",
			"dist",
			"cli.js",
		),
	);
	return { root, packageDir };
}

function createYarnGlobalInstall(): { globalDir: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "alf-yarn-"));
	const binDir = join(temp, "bin");
	const globalDir = join(temp, "yarn", "global");
	const packageDir = join(globalDir, "node_modules", "@legacy-scope", "legacy-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), createFakeYarnScript(globalDir));
	chmodSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.ALF_PACKAGE_DIR = packageDir;
	setExecPath(join(globalDir, ".yarn", "@legacy-scope", "legacy-coding-agent", "dist", "cli.js"));
	return { globalDir, packageDir };
}

function createBunGlobalInstall(): { packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "alf-bun-"));
	const prefix = join(temp, ".bun");
	const bunBin = join(prefix, "bin");
	const root = join(prefix, "install", "global", "node_modules");
	const scopeDir = join(root, "@alf-agent");
	const packageDir = join(scopeDir, "coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(bunBin, { recursive: true });
	writeFileSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), createFakeBunScript(bunBin));
	chmodSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), 0o755);
	tempDir = temp;
	process.env.PATH = `${bunBin}${delimiter}${originalPath ?? ""}`;
	process.env.ALF_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { packageDir };
}

function createFakePnpmScript(root: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="root" if "%2"=="-g" echo ${root}\r\n`;
	}
	const escapedRoot = root.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then\n\tprintf '%s\\n' '${escapedRoot}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeYarnScript(globalDir: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="global" if "%2"=="dir" echo ${globalDir}\r\n`;
	}
	const escapedGlobalDir = globalDir.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "global" ] && [ "$2" = "dir" ]; then\n\tprintf '%s\\n' '${escapedGlobalDir}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeBunScript(bunBin: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="pm" if "%2"=="bin" if "%3"=="-g" echo ${bunBin}\r\n`;
	}
	const escapedBunBin = bunBin.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "pm" ] && [ "$2" = "bin" ] && [ "$3" = "-g" ]; then\n\tprintf '%s\\n' '${escapedBunBin}'\n\texit 0\nfi\nexit 1\n`;
}

describe("detectInstallMethod", () => {
	test("detects pnpm from Windows .pnpm install paths", () => {
		setExecPath(
			"C:\\Users\\Admin\\Documents\\pnpm-repository\\global\\5\\.pnpm\\@alf-agent+coding-agent@0.67.68\\node_modules\\@alf-agent\\coding-agent\\dist\\cli.js",
		);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(getUpdateInstruction("@alf-agent/coding-agent")).toBe("Run: pnpm install -g @alf-agent/coding-agent");
	});

	test("does not self-update unknown wrapper installs", () => {
		setExecPath("/usr/local/bin/node");

		expect(detectInstallMethod()).toBe("unknown");
		expect(getSelfUpdateCommand("@alf-agent/coding-agent")).toBeUndefined();
		expect(getUpdateInstruction("@alf-agent/coding-agent")).toBe(
			"Update @alf-agent/coding-agent using the package manager, wrapper, or source checkout that provides this installation.",
		);
	});

	test("self-updates npm installs from custom prefixes", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@alf-agent/coding-agent");

		expect(detectInstallMethod()).toBe("npm");
		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "@alf-agent/coding-agent"],
			display: `npm --prefix ${prefix} install -g @alf-agent/coding-agent`,
		});
	});

	test("self-updates renamed packages from the current install prefix", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@legacy-scope/legacy-coding-agent", undefined, "@new-scope/cli");

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "@new-scope/cli"],
			display: `npm --prefix ${prefix} uninstall -g @legacy-scope/legacy-coding-agent && npm --prefix ${prefix} install -g @new-scope/cli`,
			steps: [
				{
					command: "npm",
					args: ["--prefix", prefix, "uninstall", "-g", "@legacy-scope/legacy-coding-agent"],
					display: `npm --prefix ${prefix} uninstall -g @legacy-scope/legacy-coding-agent`,
				},
				{
					command: "npm",
					args: ["--prefix", prefix, "install", "-g", "@new-scope/cli"],
					display: `npm --prefix ${prefix} install -g @new-scope/cli`,
				},
			],
		});
	});

	test("self-update respects configured npmCommand", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@alf-agent/coding-agent", ["npm", "--prefix", prefix]);

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "@alf-agent/coding-agent"],
			display: `npm --prefix ${prefix} install -g @alf-agent/coding-agent`,
		});
	});

	test("self-update treats empty npmCommand as unset", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@alf-agent/coding-agent", []);

		expect(command?.args).toEqual(["--prefix", prefix, "install", "-g", "@alf-agent/coding-agent"]);
	});

	test("quotes npm self-update display paths", () => {
		const { prefix } = createNpmPrefixInstall("alf prefix ");

		const command = getSelfUpdateCommand("@alf-agent/coding-agent");

		expect(command?.display).toBe(`npm --prefix "${prefix}" install -g @alf-agent/coding-agent`);
	});

	test("does not infer Windows npm custom prefixes from package paths", () => {
		const packageDir = "C:\\Users\\Admin\\npm prefix\\node_modules\\@alf-agent\\coding-agent";
		process.env.ALF_PACKAGE_DIR = packageDir;
		setExecPath(`${packageDir}\\dist\\cli.js`);

		expect(detectInstallMethod()).toBe("npm");
		expect(getUpdateInstruction("@alf-agent/coding-agent")).toBe("Run: npm install -g @alf-agent/coding-agent");
	});

	test("self-updates bun global installs from bun pm bin", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@alf-agent/coding-agent");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "@alf-agent/coding-agent"],
			display: "bun install -g @alf-agent/coding-agent",
		});
	});

	test("self-updates renamed pnpm global installs by removing the old package first", () => {
		createPnpmGlobalInstall();

		const command = getSelfUpdateCommand("@legacy-scope/legacy-coding-agent", undefined, "@new-scope/cli");

		expect(detectInstallMethod()).toBe("pnpm");
		expect(command).toEqual({
			command: "pnpm",
			args: ["install", "-g", "@new-scope/cli"],
			display: "pnpm remove -g @legacy-scope/legacy-coding-agent && pnpm install -g @new-scope/cli",
			steps: [
				{
					command: "pnpm",
					args: ["remove", "-g", "@legacy-scope/legacy-coding-agent"],
					display: "pnpm remove -g @legacy-scope/legacy-coding-agent",
				},
				{
					command: "pnpm",
					args: ["install", "-g", "@new-scope/cli"],
					display: "pnpm install -g @new-scope/cli",
				},
			],
		});
	});

	test("self-updates renamed yarn global installs by removing the old package first", () => {
		createYarnGlobalInstall();

		const command = getSelfUpdateCommand("@legacy-scope/legacy-coding-agent", undefined, "@new-scope/cli");

		expect(detectInstallMethod()).toBe("yarn");
		expect(command).toEqual({
			command: "yarn",
			args: ["global", "add", "@new-scope/cli"],
			display: "yarn global remove @legacy-scope/legacy-coding-agent && yarn global add @new-scope/cli",
			steps: [
				{
					command: "yarn",
					args: ["global", "remove", "@legacy-scope/legacy-coding-agent"],
					display: "yarn global remove @legacy-scope/legacy-coding-agent",
				},
				{
					command: "yarn",
					args: ["global", "add", "@new-scope/cli"],
					display: "yarn global add @new-scope/cli",
				},
			],
		});
	});

	test("self-updates renamed bun global installs by removing the old package first", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@legacy-scope/legacy-coding-agent", undefined, "@new-scope/cli");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "@new-scope/cli"],
			display: "bun uninstall -g @legacy-scope/legacy-coding-agent && bun install -g @new-scope/cli",
			steps: [
				{
					command: "bun",
					args: ["uninstall", "-g", "@legacy-scope/legacy-coding-agent"],
					display: "bun uninstall -g @legacy-scope/legacy-coding-agent",
				},
				{
					command: "bun",
					args: ["install", "-g", "@new-scope/cli"],
					display: "bun install -g @new-scope/cli",
				},
			],
		});
	});

	test("does not self-update when npm install path is not writable", () => {
		const { packageDir } = createNpmPrefixInstall();
		chmodSync(packageDir, 0o500);

		expect(getSelfUpdateCommand("@alf-agent/coding-agent")).toBeUndefined();
		expect(getSelfUpdateUnavailableInstruction("@alf-agent/coding-agent")).toContain(
			"the install path is not writable",
		);
	});
});

describe.skipIf(process.platform !== "linux")("getAgentDir (Linux XDG)", () => {
	const originalHome = process.env.HOME;
	const originalXdgConfig = process.env.XDG_CONFIG_HOME;
	const originalAlfDir = process.env.ALF_CODING_AGENT_DIR;
	const originalPiDir = process.env.ALF_CODING_AGENT_DIR;
	let xdgTempHome: string | undefined;

	afterEach(async () => {
		vi.resetModules();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		if (originalXdgConfig === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfig;
		}
		if (originalAlfDir === undefined) {
			delete process.env.ALF_CODING_AGENT_DIR;
		} else {
			process.env.ALF_CODING_AGENT_DIR = originalAlfDir;
		}
		if (originalPiDir === undefined) {
			delete process.env.ALF_CODING_AGENT_DIR;
		} else {
			process.env.ALF_CODING_AGENT_DIR = originalPiDir;
		}
		if (xdgTempHome) {
			rmSync(xdgTempHome, { recursive: true, force: true });
			xdgTempHome = undefined;
		}
	});

	test("uses ~/.config/<app>/agent when legacy dot-dir agent is absent", async () => {
		const home = mkdtempSync(join(tmpdir(), "alf-xdg-home-"));
		xdgTempHome = home;
		process.env.HOME = home;
		delete process.env.XDG_CONFIG_HOME;
		delete process.env.ALF_CODING_AGENT_DIR;
		delete process.env.ALF_CODING_AGENT_DIR;

		vi.resetModules();
		const { getAgentDir } = await import("../src/config.js");
		expect(getAgentDir()).toBe(join(home, ".config", "alf", "agent"));
	});

	test("prefers legacy ~/.alf/agent when it already exists", async () => {
		const home = mkdtempSync(join(tmpdir(), "alf-legacy-home-"));
		xdgTempHome = home;
		process.env.HOME = home;
		delete process.env.XDG_CONFIG_HOME;
		delete process.env.ALF_CODING_AGENT_DIR;
		delete process.env.ALF_CODING_AGENT_DIR;

		const legacy = join(home, ".alf", "agent");
		mkdirSync(legacy, { recursive: true });

		vi.resetModules();
		const { getAgentDir } = await import("../src/config.js");
		expect(getAgentDir()).toBe(legacy);
	});

	test("respects XDG_CONFIG_HOME when set", async () => {
		const home = mkdtempSync(join(tmpdir(), "alf-xdg-custom-"));
		xdgTempHome = home;
		process.env.HOME = home;
		process.env.XDG_CONFIG_HOME = join(home, "xdg-cfg");
		delete process.env.ALF_CODING_AGENT_DIR;
		delete process.env.ALF_CODING_AGENT_DIR;
		mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });

		vi.resetModules();
		const { getAgentDir } = await import("../src/config.js");
		expect(getAgentDir()).toBe(join(home, "xdg-cfg", "alf", "agent"));
	});
});
