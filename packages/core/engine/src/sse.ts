/**
 * EventStream — tracks connected SSE clients and broadcasts events.
 *
 * Each connected client is a raw Node.js ServerResponse with headers set for
 * the text/event-stream protocol. Events are formatted as:
 *
 *   event: command/fs.read\n
 *   data: {"bus":"command","type":"fs.read",...}\n
 *   \n
 *
 * Clients that close their connection are removed automatically via the
 * 'close' event on the response.
 */

import type { ServerResponse } from "node:http";

/** Wire format for a single bus message sent over SSE. */
export interface BusEvent {
	bus: "command" | "event" | "notification";
	type: string;
	correlationId: string;
	payload: Record<string, unknown>;
	timestamp: number;
}

/** Manages connected SSE clients and broadcasts serialized bus events to them. */
export class EventStream {
	private readonly clients = new Set<ServerResponse>();

	/** Register a new SSE client. Sets headers and schedules cleanup on close. */
	add(res: ServerResponse): void {
		// eslint-disable-next-line no-magic-numbers
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			// Allow cross-origin connections from web UIs served from a different port.
			"Access-Control-Allow-Origin": "*",
		});
		// Send a comment to flush the headers immediately (some proxies buffer).
		res.write(": connected\n\n");

		this.clients.add(res);
		res.once("close", () => this.clients.delete(res));
	}

	/** Broadcast a bus event to all connected clients. */
	broadcast(event: BusEvent): void {
		const eventName = `${event.bus}/${event.type}`;
		this.broadcastFrame(eventName, JSON.stringify(event));
	}

	/** Broadcast an arbitrary JSON payload under a custom event name. */
	broadcastRaw(eventName: string, payload: Record<string, unknown>): void {
		this.broadcastFrame(eventName, JSON.stringify(payload));
	}

	private broadcastFrame(eventName: string, data: string): void {
		if (this.clients.size === 0) return;
		const frame = `event: ${eventName}\ndata: ${data}\n\n`;
		for (const client of this.clients) {
			client.write(frame, (err) => {
				if (err) this.clients.delete(client);
			});
		}
	}

	/** Number of currently connected SSE clients. */
	get size(): number {
		return this.clients.size;
	}

	/** Flush and close all client connections (called on adapter unmount). */
	closeAll(): void {
		for (const client of this.clients) {
			client.end();
		}
		this.clients.clear();
	}
}
