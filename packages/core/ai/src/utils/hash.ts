/** Fast deterministic hash to shorten long strings */
export function shortHash(str: string): string {
	// eslint-disable-next-line no-magic-numbers
	let h1 = 0xdeadbeef;
	// eslint-disable-next-line no-magic-numbers
	let h2 = 0x41c6ce57;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		// eslint-disable-next-line no-magic-numbers
		h1 = Math.imul(h1 ^ ch, 2654435761);
		// eslint-disable-next-line no-magic-numbers
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	// eslint-disable-next-line no-magic-numbers
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	// eslint-disable-next-line no-magic-numbers
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	// eslint-disable-next-line no-magic-numbers
	return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}
