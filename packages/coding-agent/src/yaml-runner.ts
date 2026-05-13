import { parseArgs } from "./cli/args.js";
import { type MainOptions, main } from "./main.js";

/**
 * Thin facade for YAML-defined runtime execution.
 * Keeps `coding-agent` as CLI/container while composition lives in runtime/organs.
 */
export async function runYamlRunner(args: string[], options?: MainOptions): Promise<void> {
	const parsed = parseArgs(args);
	if (!parsed.blueprint) {
		throw new Error("runYamlRunner requires --blueprint <path>.");
	}
	if (parsed.mode === "rpc") {
		throw new Error("runYamlRunner does not support --mode rpc.");
	}
	const nextArgs = [...args];
	if (!parsed.print && parsed.mode === undefined) {
		nextArgs.unshift("--print");
	}
	await main(nextArgs, options);
}
