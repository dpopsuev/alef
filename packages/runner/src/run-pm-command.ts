import type { Args } from "./args.js";

export async function handleSelfUpdate(args: Args): Promise<void> {
	if (!args.pmSelfUpdate) return;
	const { execSync } = await import("node:child_process");
	const npmCmd = process.env.npm_execpath ? `${process.execPath} "${process.env.npm_execpath}"` : "npm";
	console.log("Upgrading alef to the latest version...");
	try {
		execSync(`${npmCmd} install -g alef-runner@latest`, { stdio: "inherit" });
	} catch {
		console.error("npm install -g alef-runner@latest failed.");
		process.exit(1);
	}
	let globalBin: string;
	try {
		globalBin = `${execSync("npm prefix -g", { encoding: "utf-8" }).trim()}/bin/alef`;
	} catch {
		globalBin = "";
	}
	if (globalBin) {
		console.log(`Upgrade complete. New binary: ${globalBin}`);
	} else {
		console.log("Upgrade complete. Restart alef to use the new version.");
	}
	process.exit(0);
}

export async function runPmCommand(args: Args): Promise<boolean> {
	const hasPmFlag =
		args.pmInstall ||
		args.pmRemove ||
		args.pmUpgrade ||
		args.pmRollback !== undefined ||
		args.pmHistory ||
		args.pmAudit ||
		args.pmGc ||
		args.pmSearch !== undefined ||
		args.pmSbom ||
		args.pmOrganList ||
		args.pmOrganNew !== undefined ||
		args.pmExport !== undefined ||
		args.pmImport !== undefined;

	if (!hasPmFlag) return false;

	const pm = await import("./alef-pm.js");
	pm.init();

	if (args.pmInstall) {
		const [name, version] = args.pmInstall.split("@");
		const gen = await pm.install(name, version);
		console.log(`Installed ${args.pmInstall} (generation ${gen})`);
	} else if (args.pmRemove) {
		const gen = await pm.remove(args.pmRemove);
		console.log(`Removed ${args.pmRemove} (generation ${gen})`);
	} else if (args.pmUpgrade) {
		const gen = await pm.upgrade();
		console.log(`Upgraded organs (generation ${gen})`);
	} else if (args.pmRollback !== undefined) {
		const entries = pm.history();
		const target = args.pmRollback === -1 ? (entries[1]?.id ?? 1) : args.pmRollback;
		await pm.rollback(target);
		console.log(`Rolled back to generation ${target}`);
	} else if (args.pmHistory) {
		const entries = pm.history();
		if (entries.length === 0) console.log("No generations recorded.");
		for (const e of entries) {
			const organs =
				Object.entries(e.organs)
					.map(([k, v]) => `${k}@${v}`)
					.join(", ") || "(none)";
			console.log(`  Gen ${e.id}  ${e.ts.slice(0, 19)}  alef=${e.alef}  organs: ${organs}`);
		}
	} else if (args.pmAudit) {
		await pm.audit();
	} else if (args.pmGc) {
		const { removedGenerations, removedStoreEntries } = pm.gc();
		console.log(`GC: removed ${removedGenerations} generations, ${removedStoreEntries} store entries`);
	} else if (args.pmSearch !== undefined) {
		const results = await pm.search(args.pmSearch);
		if (results.length === 0) {
			console.log("No organs found.");
		} else {
			const nameW = Math.max(4, ...results.map((r) => r.name.length));
			const verW = Math.max(7, ...results.map((r) => r.version.length));
			const dlW = 9;
			console.log(`${"NAME".padEnd(nameW)}  ${"VERSION".padEnd(verW)}  ${"DOWNLOADS".padEnd(dlW)}  DESCRIPTION`);
			for (const r of results) {
				const dl = r.downloads.toLocaleString();
				console.log(`${r.name.padEnd(nameW)}  ${r.version.padEnd(verW)}  ${dl.padEnd(dlW)}  ${r.description}`);
			}
		}
	} else if (args.pmSbom) {
		console.log(JSON.stringify(pm.sbom(), null, 2));
	} else if (args.pmOrganList) {
		const { loadUserOrgansConfig, userOrgansConfigPath } = await import("@dpopsuev/alef-agent-blueprint");
		const organs = loadUserOrgansConfig();
		if (!organs || organs.length === 0) {
			console.log(`No organs registered in ${userOrgansConfigPath()}`);
		} else {
			console.log(`Organs registered in ${userOrgansConfigPath()}:`);
			for (const o of organs) {
				console.log(`  ${o.name}${o.path ? `  path: ${o.path}` : ""}`);
			}
		}
	} else if (args.pmOrganNew !== undefined) {
		if (!args.pmOrganNew.trim()) {
			console.error("Usage: alef organ new <name>");
			process.exit(1);
		}
		const { scaffoldOrgan } = await import("./organ-scaffold.js");
		const dir = scaffoldOrgan(args.pmOrganNew, args.cwd);
		console.log(`Scaffolded organ at ${dir}`);
		console.log(`  cd ${dir}\n  npm install\n  npm run build\n  alef install ./${dir.split("/").pop() ?? ""}`);
	} else if (args.pmExport !== undefined) {
		const outputPath = typeof args.pmExport === "string" ? args.pmExport : undefined;
		const written = pm.exportLockfile(args.cwd, outputPath);
		console.log(`Exported organ lockfile → ${written}`);
		console.log("Commit this file alongside your code for reproducible organ installs.");
	} else if (args.pmImport !== undefined) {
		const inputPath = typeof args.pmImport === "string" ? args.pmImport : undefined;
		const gen = await pm.importLockfile(args.cwd, inputPath);
		console.log(`Restored organs from lockfile (generation ${gen})`);
	}

	process.exit(0);
}
