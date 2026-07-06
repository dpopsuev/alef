import type { Embedder } from "./embedder.js";

type PipelineFn = (text: string, opts: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }>;

let cached: PipelineFn | undefined;

async function getPipeline(): Promise<PipelineFn> {
	if (cached) return cached;
	const { pipeline } = await import("@xenova/transformers");
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- transformers pipeline returns generic type; narrowing to PipelineFn
	cached = (await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")) as unknown as PipelineFn;
	return cached;
}

export class LocalEmbedder implements Embedder {
	async embed(text: string): Promise<number[]> {
		const fn = await getPipeline();
		const result = await fn(text, { pooling: "mean", normalize: true });
		return Array.from(result.data);
	}
}
