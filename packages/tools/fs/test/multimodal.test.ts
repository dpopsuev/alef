import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusFixture } from "@dpopsuev/alef-testkit/adapter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFsAdapter } from "../src/adapter.js";

let testDir: string;

beforeEach(async () => {
	testDir = join(tmpdir(), `alef-fs-multimodal-test-${Date.now()}`);
	await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
	await rm(testDir, { recursive: true, force: true });
});

function fixture() {
	const f = new BusFixture();
	f.mount(createFsAdapter({ cwd: testDir }));
	return f;
}

/** Create a minimal valid PNG image (1x1 transparent pixel). */
function createPngBuffer(): Buffer {
	// PNG signature + IHDR + IDAT + IEND chunks for a 1x1 transparent image
	return Buffer.from([
		// PNG signature
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		// IHDR chunk: 1x1 pixel, 8-bit RGBA
		0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
		0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
		// IDAT chunk: compressed image data
		0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54,
		0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01,
		0x0d, 0x0a, 0x2d, 0xb4,
		// IEND chunk
		0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
		0xae, 0x42, 0x60, 0x82,
	]);
}

/** Create a minimal valid JPEG image. */
function createJpegBuffer(): Buffer {
	// JPEG signature + minimal structure
	return Buffer.from([
		// JPEG SOI marker
		0xff, 0xd8,
		// APP0 marker (JFIF)
		0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
		// SOF0 marker (baseline)
		0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
		// DHT marker (Huffman table)
		0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03,
		// SOS marker (start of scan)
		0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
		// Minimal scan data
		0xd2, 0xcf, 0x20,
		// EOI marker
		0xff, 0xd9,
	]);
}

/** Create a minimal valid GIF image. */
function createGifBuffer(): Buffer {
	// GIF87a signature + minimal 1x1 image
	return Buffer.from([
		// GIF signature "GIF87a"
		0x47, 0x49, 0x46, 0x38, 0x37, 0x61,
		// Logical screen descriptor: 1x1
		0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
		// Global color table (2 colors)
		0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
		// Image descriptor
		0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
		// Image data
		0x02, 0x02, 0x44, 0x01, 0x00,
		// Trailer
		0x3b,
	]);
}

/** Create a minimal valid WebP image. */
function createWebpBuffer(): Buffer {
	// RIFF WebP signature + minimal VP8 chunk
	return Buffer.from([
		// RIFF signature
		0x52, 0x49, 0x46, 0x46,
		// File size (little-endian, placeholder)
		0x26, 0x00, 0x00, 0x00,
		// WEBP signature
		0x57, 0x45, 0x42, 0x50,
		// VP8 chunk
		0x56, 0x50, 0x38, 0x20,
		// Chunk size
		0x1a, 0x00, 0x00, 0x00,
		// VP8 bitstream (minimal)
		0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	]);
}

describe("FsAdapter multimodal support", { tags: ["integration"] }, () => {
	it("returns image content block with base64 data URI for PNG files", async () => {
		const pngPath = join(testDir, "test.png");
		await writeFile(pngPath, createPngBuffer());

		const f = fixture();
		const result = await f.call("fs.read", { path: "test.png" });

		expect(result.isError).toBe(false);
		expect(result.payload.type).toBe("image");
		expect(result.payload.mimeType).toBe("image/png");
		expect(result.payload.data).toMatch(/^data:image\/png;base64,/);
		expect(result.payload.sizeBytes).toBeGreaterThan(0);

		// Verify base64 content is valid
		const base64 = (result.payload.data as string).split(",")[1];
		expect(base64).toBeTruthy();
		const decoded = Buffer.from(base64!, "base64");
		expect(decoded.length).toBeGreaterThan(0);

		f.dispose();
	});

	it("returns image content block for JPEG files", async () => {
		const jpegPath = join(testDir, "test.jpg");
		await writeFile(jpegPath, createJpegBuffer());

		const f = fixture();
		const result = await f.call("fs.read", { path: "test.jpg" });

		expect(result.isError).toBe(false);
		expect(result.payload.type).toBe("image");
		expect(result.payload.mimeType).toBe("image/jpeg");
		expect(result.payload.data).toMatch(/^data:image\/jpeg;base64,/);

		f.dispose();
	});

	it("returns image content block for GIF files", async () => {
		const gifPath = join(testDir, "test.gif");
		await writeFile(gifPath, createGifBuffer());

		const f = fixture();
		const result = await f.call("fs.read", { path: "test.gif" });

		expect(result.isError).toBe(false);
		expect(result.payload.type).toBe("image");
		expect(result.payload.mimeType).toBe("image/gif");
		expect(result.payload.data).toMatch(/^data:image\/gif;base64,/);

		f.dispose();
	});

	it("returns image content block for WebP files", async () => {
		const webpPath = join(testDir, "test.webp");
		await writeFile(webpPath, createWebpBuffer());

		const f = fixture();
		const result = await f.call("fs.read", { path: "test.webp" });

		expect(result.isError).toBe(false);
		expect(result.payload.type).toBe("image");
		expect(result.payload.mimeType).toBe("image/webp");
		expect(result.payload.data).toMatch(/^data:image\/webp;base64,/);

		f.dispose();
	});

	it("rejects images larger than 5MB with size-based error", async () => {
		const largePath = join(testDir, "large.png");
		// Create a buffer larger than 5MB (5 * 1024 * 1024 bytes)
		const largeBuffer = Buffer.alloc(6 * 1024 * 1024);
		// Write PNG signature so it's detected as image/png
		largeBuffer.write(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("binary"), 0, "binary");
		await writeFile(largePath, largeBuffer);

		const f = fixture();
		const result = await f.call("fs.read", { path: "large.png" });

		expect(result.isError).toBe(true);
		expect(result.errorMessage).toMatch(/too large/i);
		expect(result.errorMessage).toMatch(/5MB/);

		f.dispose();
	});

	it("rejects non-image binary files with error message", async () => {
		const pdfPath = join(testDir, "test.pdf");
		// PDF signature
		const pdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
		await writeFile(pdfPath, pdfBuffer);

		const f = fixture();
		const result = await f.call("fs.read", { path: "test.pdf" });

		expect(result.isError).toBe(true);
		expect(result.errorMessage).toMatch(/binary file/i);
		expect(result.errorMessage).toMatch(/application\/pdf/);

		f.dispose();
	});

	it("still reads text files normally", async () => {
		const textPath = join(testDir, "test.txt");
		await writeFile(textPath, "Hello, World!\nLine 2\nLine 3");

		const f = fixture();
		const result = await f.call("fs.read", { path: "test.txt" });

		expect(result.isError).toBe(false);
		expect(result.payload.content).toContain("Hello, World!");
		expect(result.payload.content).toContain("Line 2");
		// Should not have image-specific fields
		expect(result.payload.type).toBeUndefined();
		expect(result.payload.mimeType).toBeUndefined();

		f.dispose();
	});

	it("detects image files by extension when using different extensions", async () => {
		// Test .jpeg extension (vs .jpg)
		const jpegPath = join(testDir, "test.jpeg");
		await writeFile(jpegPath, createJpegBuffer());

		const f = fixture();
		const result = await f.call("fs.read", { path: "test.jpeg" });

		expect(result.isError).toBe(false);
		expect(result.payload.type).toBe("image");
		expect(result.payload.mimeType).toBe("image/jpeg");

		f.dispose();
	});
});
