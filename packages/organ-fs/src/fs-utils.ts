import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";

export async function atomicWrite(dest: string, content: string): Promise<void> {
	const tmp = `${dest}.tmp.${randomUUID()}`;
	try {
		await writeFile(tmp, content, "utf-8");
		await rename(tmp, dest);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
}
