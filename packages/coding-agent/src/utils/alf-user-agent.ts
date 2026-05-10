export function getAlfUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `alf/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
