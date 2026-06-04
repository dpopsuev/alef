function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyTextEdit(content: string, oldText: string, newText: string, path: string): string {
	const first = content.indexOf(oldText);
	if (first === -1) throw new Error(`lector.edit: oldText not found in ${path}`);
	const last = content.lastIndexOf(oldText);
	if (first !== last) throw new Error(`lector.edit: oldText matches multiple locations in ${path} — make it unique`);
	return content.slice(0, first) + newText + content.slice(first + oldText.length);
}

export function buildDeclRe(symbol: string): RegExp {
	return new RegExp(String.raw`\b(?:function|class|interface|type|const|let|var)\s+${escapeRegex(symbol)}\b`);
}
