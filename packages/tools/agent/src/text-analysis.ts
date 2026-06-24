const WRITE_PATTERN =
	/\b(write|create|edit|modify|delete|remove|install|run|execute|build|deploy|fix|refactor|update|change|add|implement|spawn|generate)\b/i;

function extractKeywords(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, " ")
			.split(/\s+/)
			.filter((w) => w.length > 3),
	);
}

export function checkRelevance(
	prompt: string,
	reply: string,
): { relevant: boolean; overlap: number; shallow: boolean } {
	if (!reply || reply.length < 20) return { relevant: false, overlap: 0, shallow: true };
	const promptWords = extractKeywords(prompt);
	const replyWords = extractKeywords(reply.slice(0, 2000));
	if (promptWords.size === 0) return { relevant: true, overlap: 1, shallow: false };
	let hits = 0;
	for (const w of promptWords) if (replyWords.has(w)) hits++;
	const overlap = hits / promptWords.size;
	const shallow = prompt.length > 200 && reply.length < 100;
	return { relevant: overlap > 0.1, overlap, shallow };
}

export function needsWriteAccess(text: string): boolean {
	return WRITE_PATTERN.test(text);
}
