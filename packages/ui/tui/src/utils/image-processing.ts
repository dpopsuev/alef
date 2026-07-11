import sharp from "sharp";

/**
 * Configuration options for image processing.
 */
export interface ImageProcessingOptions {
	maxDimension?: number; // Default: 1568 (standard), 2576 (high)
	quality?: "standard" | "high";
	maxFileSize?: number; // Default: 5MB
	format?: "png" | "jpeg" | "webp";
}

/**
 * Result of image processing operation.
 */
export interface ProcessedImage {
	buffer: Buffer;
	mimeType: string;
	width: number;
	height: number;
	originalSize: number;
	processedSize: number;
}

/**
 * Process image for optimal LLM vision API submission.
 * Resizes to recommended dimensions and compresses to reduce token costs.
 *
 * Standard (1568px): Optimal for OCR, text, code - saves 50-87% tokens
 * High (2576px): Better for spatial tasks, UI automation, design review
 *
 * @param buffer - Input image buffer
 * @param options - Processing configuration options
 * @param timeoutMs - Processing timeout in milliseconds (default: 30000)
 * @returns Processed image with metadata
 * @throws Error if processing times out or fails
 */
export async function processImage(
	buffer: Buffer,
	options: ImageProcessingOptions = {},
	timeoutMs: number = 30000,
): Promise<ProcessedImage> {
	return Promise.race([
		processImageInternal(buffer, options),
		new Promise<ProcessedImage>((_, reject) =>
			setTimeout(
				() => reject(new Error("Image processing timeout - image too large or complex")),
				timeoutMs,
			),
		),
	]);
}

/**
 * Internal image processing implementation.
 * Separated from public API to enable timeout wrapping.
 */
async function processImageInternal(
	buffer: Buffer,
	options: ImageProcessingOptions,
): Promise<ProcessedImage> {
	const {
		quality = "standard",
		maxDimension = quality === "high" ? 2576 : 1568,
		format = "png",
	} = options;

	const originalSize = buffer.length;

	// Load image and get metadata
	const image = sharp(buffer);
	const metadata = await image.metadata();

	if (!metadata.width || !metadata.height) {
		throw new Error("Unable to read image dimensions");
	}

	const longEdge = Math.max(metadata.width, metadata.height);
	let processed = image;

	// Resize if needed
	if (longEdge > maxDimension) {
		processed = processed.resize(maxDimension, maxDimension, {
			fit: "inside",
			kernel: "lanczos3", // Best quality resampling
			withoutEnlargement: true,
		});
	}

	// Apply format-specific compression
	if (format === "png") {
		processed = processed.png({
			compressionLevel: 9,
			effort: 10, // Max compression effort
		});
	} else if (format === "jpeg") {
		processed = processed.jpeg({
			quality: 90,
			mozjpeg: true, // Better compression
		});
	} else {
		// format === 'webp'
		processed = processed.webp({
			quality: 90,
			effort: 6,
		});
	}

	const result = await processed.toBuffer({ resolveWithObject: true });

	return {
		buffer: result.data,
		mimeType: `image/${format}`,
		width: result.info.width,
		height: result.info.height,
		originalSize,
		processedSize: result.data.length,
	};
}

/**
 * Get optimal processing options based on use case.
 *
 * @param useCase - The intended use case for the image
 * @returns Recommended processing options
 */
export function getProcessingOptions(
	useCase: "general" | "spatial" | "cost-optimized",
): ImageProcessingOptions {
	switch (useCase) {
		case "general":
			return { quality: "standard", maxDimension: 1568 };
		case "spatial":
			return { quality: "high", maxDimension: 2576 };
		case "cost-optimized":
			return { quality: "standard", maxDimension: 1024 };
		default:
			return { quality: "standard", maxDimension: 1568 };
	}
}
