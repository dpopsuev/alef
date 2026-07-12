/**
 *
 */
export interface TextSignatureV1 {
	v: 1;
	id: string;
	phase?: "commentary" | "final_answer";
}

/**
 *
 */
export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

/**
 *
 */
export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}
