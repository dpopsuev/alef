import { loadAgentDefinition } from "@dpopsuev/alef-blueprint/blueprints";
import { materializeBlueprint } from "@dpopsuev/alef-blueprint/materializer";
import type { BlueprintStack, BlueprintStackOptions } from "@dpopsuev/alef-blueprint/registry";
import { blueprintRegistry } from "@dpopsuev/alef-blueprint/registry";
import { createContextAssembler } from "@dpopsuev/alef-kernel/context-assembly";
import { listInstalled, resolveAdapterPath } from "../pkg/alef-pm.js";

/** Scan PM-installed packages for blueprint manifests and register them in the global registry. */
export function initPmBlueprints(): void {
	const installed = listInstalled();
	let count = 0;

	for (const pkg of installed) {
		if (pkg.manifest?.type !== "blueprint") continue;

		try {
			const definition = loadAgentDefinition(pkg.entry);
			const name = definition.name || pkg.name;

			const factory = async (opts: BlueprintStackOptions): Promise<BlueprintStack> => {
				const { adapters } = await materializeBlueprint(definition, {
					cwd: opts.cwd,
					loggerFor: () => {
						const noop = () => {};
						const noopLogger = { info: noop, warn: noop, error: noop, debug: noop, child: () => noopLogger };
						return noopLogger;
					},
					allowedTools: ["*"],
					writableRoots: opts.writableRoots,
					resolveExternalPath: resolveAdapterPath,
				});
				return { adapters, contextAssembly: createContextAssembler() };
			};

			blueprintRegistry.register(name, factory);
			count++;
		} catch {
			// skip unloadable blueprints
		}
	}

	if (count > 0) {
		process.stderr.write(`[alef] registered ${count} PM blueprint(s): ${blueprintRegistry.list().join(", ")}\n`);
	}
}
