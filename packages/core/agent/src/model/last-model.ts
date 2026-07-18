/**
 * Persist the last :model pick under XDG state so the next process boot
 * resolves the same model without --model / ALEF_MODEL.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { lastModelPath } from "@dpopsuev/alef-kernel/xdg";

/** Read the last user-picked model id, or undefined when unset/invalid. */
export function readLastModel(): string | undefined {
	const path = lastModelPath();
	if (!existsSync(path)) return undefined;
	try {
		const id = readFileSync(path, "utf-8").trim();
		return id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

/** Remember a model id from :model / setModel for the next process boot. */
export function rememberLastModel(modelId: string): void {
	const id = modelId.trim();
	if (!id) return;
	const path = lastModelPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${id}\n`, "utf-8");
}
