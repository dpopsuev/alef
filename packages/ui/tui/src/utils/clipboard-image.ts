import { execSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";

/**
 * Result of reading an image from the clipboard
 */
export interface ClipboardImage {
	/** Raw image data as a Buffer */
	data: Buffer;
	/** MIME type of the image (e.g., 'image/png', 'image/jpeg') */
	mimeType: string;
}

/**
 * Read an image from the system clipboard
 * @returns ClipboardImage if an image is present, null otherwise
 */
export function readClipboardImage(): ClipboardImage | null {
	const platform = process.platform;

	try {
		if (platform === "darwin") {
			return readMacOSClipboardImage();
		}
		if (platform === "linux") {
			return readLinuxClipboardImage();
		}
		if (platform === "win32") {
			return readWindowsClipboardImage();
		}
	} catch {
		// Silently fail - clipboard might not have an image or tool might not be available
		return null;
	}

	return null;
}

/**
 * Read clipboard image on macOS using osascript
 */
function readMacOSClipboardImage(): ClipboardImage | null {
	try {
		// Check clipboard type
		const typeCheck = execSync('osascript -e "clipboard info"', {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"], // Suppress stderr
		});

		// Check for PNG or JPEG
		const hasPNG = typeCheck.includes("«class PNGf»") || typeCheck.includes("public.png");
		const hasJPEG = typeCheck.includes("«class JPEG»") || typeCheck.includes("public.jpeg");

		if (!hasPNG && !hasJPEG) {
			return null;
		}

		// Prefer PNG, fall back to JPEG
		const mimeType = hasPNG ? "image/png" : "image/jpeg";
		const typeClass = hasPNG ? "PNGf" : "JPEG";

		// Read image data
		// Note: osascript outputs hex data, we need to convert it to binary
		const data = execSync(
			`osascript -e "get the clipboard as «class ${typeClass}»" | xxd -r -p`,
			{
				encoding: "buffer",
				maxBuffer: 50 * 1024 * 1024, // 50MB max
				stdio: ["pipe", "pipe", "ignore"],
			},
		);

		if (data.length === 0) {
			return null;
		}

		return { data, mimeType };
	} catch {
		return null;
	}
}

/**
 * Read clipboard image on Linux using xclip or wl-paste
 */
function readLinuxClipboardImage(): ClipboardImage | null {
	// Try xclip first (X11)
	try {
		const data = execSync("xclip -selection clipboard -t image/png -o", {
			encoding: "buffer",
			maxBuffer: 50 * 1024 * 1024,
			stdio: ["pipe", "pipe", "ignore"],
		});

		if (data.length > 0) {
			return { data, mimeType: "image/png" };
		}
	} catch {
		// xclip failed or not available, try wl-paste
	}

	// Try wl-paste (Wayland)
	try {
		const data = execSync("wl-paste --type image/png", {
			encoding: "buffer",
			maxBuffer: 50 * 1024 * 1024,
			stdio: ["pipe", "pipe", "ignore"],
		});

		if (data.length > 0) {
			return { data, mimeType: "image/png" };
		}
	} catch {
		// wl-paste failed or not available
	}

	// Try JPEG formats as fallback
	try {
		const data = execSync("xclip -selection clipboard -t image/jpeg -o", {
			encoding: "buffer",
			maxBuffer: 50 * 1024 * 1024,
			stdio: ["pipe", "pipe", "ignore"],
		});

		if (data.length > 0) {
			return { data, mimeType: "image/jpeg" };
		}
	} catch {
		// JPEG also failed
	}

	return null;
}

/**
 * Read clipboard image on Windows using PowerShell
 */
function readWindowsClipboardImage(): ClipboardImage | null {
	const tempFile = `${process.env.TEMP ?? process.env.TMP ?? "/tmp"}/alef-clipboard-${Date.now()}.png`;

	try {
		// Use PowerShell to save clipboard image to temp file
		execSync(
			`powershell -command "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $img.Save('${tempFile}', [System.Drawing.Imaging.ImageFormat]::Png) }"`,
			{
				stdio: "ignore",
			},
		);

		// Read the temp file
		const data = readFileSync(tempFile);

		// Clean up temp file
		try {
			unlinkSync(tempFile);
		} catch {
			// Ignore cleanup errors
		}

		if (data.length === 0) {
			return null;
		}

		return { data, mimeType: "image/png" };
	} catch {
		// Clean up temp file on error
		try {
			unlinkSync(tempFile);
		} catch {
			// Ignore cleanup errors
		}
		return null;
	}
}

/**
 * Convert a Buffer to base64 string using chunked processing to avoid stack overflow
 * @param buffer - Buffer to encode
 * @returns base64 encoded string
 */
export function bufferToBase64(buffer: Buffer): string {
	// For Node.js Buffer, we can use the built-in toString method
	// which handles large buffers efficiently
	return buffer.toString("base64");
}

/**
 * Detect MIME type from buffer by checking magic bytes
 * @param buffer - Buffer to check
 * @returns MIME type string or 'application/octet-stream' if unknown
 */
export function detectMimeType(buffer: Buffer): string {
	if (buffer.length < 4) {
		return "application/octet-stream";
	}

	// PNG: 89 50 4E 47
	if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
		return "image/png";
	}

	// JPEG: FF D8 FF
	if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
		return "image/jpeg";
	}

	// GIF: 47 49 46 38
	if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
		return "image/gif";
	}

	// WebP: 52 49 46 46 ... 57 45 42 50
	if (
		buffer.length >= 12 &&
		buffer[0] === 0x52 &&
		buffer[1] === 0x49 &&
		buffer[2] === 0x46 &&
		buffer[3] === 0x46 &&
		buffer[8] === 0x57 &&
		buffer[9] === 0x45 &&
		buffer[10] === 0x42 &&
		buffer[11] === 0x50
	) {
		return "image/webp";
	}

	// BMP: 42 4D
	if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
		return "image/bmp";
	}

	// TIFF: 49 49 2A 00 (little-endian) or 4D 4D 00 2A (big-endian)
	if (
		(buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
		(buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)
	) {
		return "image/tiff";
	}

	return "application/octet-stream";
}
