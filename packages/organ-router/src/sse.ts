/**
 * SseManager — tracks connected SSE clients and broadcasts events.
 *
 * Each connected client is a raw Node.js ServerResponse with headers set for
 * the text/event-stream protocol. Events are formatted as:
 *
 *   event: motor/fs.read\n
 *   data: {"bus":"motor","type":"fs.read",...}\n
 *   \n
 *
 * Clients that close their connection are removed automatically via the
 * 'close' event on the response.
 */

import type { ServerResponse } from "node:http";

export interface BusEvent {
	bus: "motor" | "sense";
	type: string;
	correlationId: string;
	payload: Record<string, unknown>;
	timestamp: number;
}

export class SseManager {
	private readonly clients = new Set<ServerResponse>();

	/** Register a new SSE client. Sets headers and schedules cleanup on close. */
	add(res: ServerResponse): void {
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
		if (this.clients.size === 0) return;

		const eventName = `${event.bus}/${event.type}`;
		const data = JSON.stringify(event);
		const frame = `event: ${eventName}\ndata: ${data}\n\n`;

		for (const client of this.clients) {
			// Ignore write errors — client may have disconnected between the
			// size check and the write. The 'close' handler will clean up.
			client.write(frame, (err) => {
				if (err) this.clients.delete(client);
			});
		}
	}

	/** Number of currently connected SSE clients. */
	get size(): number {
		return this.clients.size;
	}

	/** Flush and close all client connections (called on organ unmount). */
	closeAll(): void {
		for (const client of this.clients) {
			client.end();
		}
		this.clients.clear();
	}
}
