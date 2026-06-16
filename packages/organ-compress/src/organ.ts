import { defineOrgan, typedAction, withDisplay } from "@dpopsuev/alef-kernel";
import { z } from "zod";

export interface CompressOrganOptions {
	cwd: string;
}

const TOOL = {
	name: "compress.text",
	description: "Compress text by extracting the first sentence of each paragraph.",
	inputSchema: z.object({
		input: z.string().min(1).describe("The text to compress"),
	}),
};

function compressText(input: string): { original: string; compressed: string; ratio: number } {
	// Split into paragraphs (separated by blank lines or newlines)
	const paragraphs = input.split(/\n\n+/).filter((p) => p.trim().length > 0);

	// Extract first sentence from each paragraph
	const compressed = paragraphs
		.map((paragraph) => {
			// Clean the paragraph
			const cleaned = paragraph.trim();
			// Find first sentence (look for . ! ? followed by space or end)
			const match = cleaned.match(/^[^.!?]+[.!?](?:\s|$)/);
			if (match) {
				return match[0].trim();
			}
			// If no sentence ending found, return first line
			const firstLine = cleaned.split("\n")[0];
			return firstLine;
		})
		.join(" ");

	const original = input;
	const ratio = original.length > 0 ? compressed.length / original.length : 0;

	return { original, compressed, ratio };
}

export function createCompressOrgan(_opts: CompressOrganOptions) {
	return defineOrgan(
		"compress",
		{
			motor: {
				"compress.text": typedAction(TOOL, async (ctx) => {
					const { input } = ctx.payload;
					const result = compressText(input);
					return withDisplay(result, {
						text: `Compressed ${result.original.length} → ${result.compressed.length} chars (${(result.ratio * 100).toFixed(1)}%)`,
						mimeType: "text/plain",
					});
				}),
			},
		},
		{
			description: "Text compression by extracting first sentences from paragraphs.",
			directives: ["Use compress.text to reduce text length while preserving key information from each paragraph."],
			labels: ["compress"],
		},
	);
}
