/**
 * Image attachment for TUI editor
 * Matches Web UI pattern for image attachments
 */
export interface ImageAttachment {
	id: string;
	type: "image";
	fileName: string;
	mimeType: string;
	size: number;
	content: string; // base64 WITHOUT data URL prefix
	width?: number;
	height?: number;
}
