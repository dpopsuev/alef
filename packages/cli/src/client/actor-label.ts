/**
 *
 */
export function displayActorName(address: string | undefined, fallback: string): string {
	const trimmed = address?.trim();
	if (!trimmed) return fallback;
	return trimmed.replace(/^@+/, "") || fallback;
}
