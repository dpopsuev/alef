/** Shared assertions for dock-chrome scrollback purity. */

export const STICKY_FINGERPRINTS = [
	"STICKY_INSERT",
	"STICKY_EDITOR",
	"STICKY_TOPIC",
	"STICKY_FOOTER",
	"STICKY_CARD",
	"─ INSERT ",
	"─ NORMAL ",
] as const;

export function extractArchivePayloads(writes: string[]): string[] {
	const payloads: string[] = [];
	for (const write of writes) {
		if (!/\x1b\[1;\d+r/.test(write)) continue;
		const parts = write.split(/\r\n\x1b\[2K/);
		for (let i = 1; i < parts.length; i++) {
			const line = (parts[i] ?? "")
				.replace(/\x1b\[r[\s\S]*$/, "")
				.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
			payloads.push(line);
		}
	}
	return payloads;
}

export function dockChromeHits(lines: readonly string[]): string[] {
	const joined = lines.join("\n");
	return STICKY_FINGERPRINTS.filter((fingerprint) => joined.includes(fingerprint));
}
