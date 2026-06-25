import type { Terminal } from "@dpopsuev/alef-tui";

export interface Presentation {
	start(): Promise<void>;
	stop(): void;
}

export interface PresentationOptions {
	terminal?: Terminal;
}

export type PresentationFactory = (opts: PresentationOptions) => Presentation;
