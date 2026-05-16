/**
 * Output sinks — how the agent's replies reach the caller.
 *
 * Text sink:  plain text to stdout. Human-readable. Default.
 * JSON sink:  structured JSONL events to stdout. Machine-readable.
 *             Used by TUI consumers (pi, programmatic callers).
 *
 * JSONL format (one JSON object per line):
 *   { "type": "reply", "text": "...", "ts": 1234567890 }
 *
 * Future event types (when streaming lands):
 *   { "type": "tool_call", "name": "fs.read", "input": { "path": "..." } }
 *   { "type": "tool_result", "name": "fs.read", "isError": false }
 *   { "type": "done" }
 */

export type Sink = (text: string) => void;

export function textSink(): Sink {
	return (text) => console.log(text);
}

export function jsonSink(): Sink {
	return (text) => {
		process.stdout.write(JSON.stringify({ type: "reply", text, ts: Date.now() }) + "\n");
	};
}

export function makeSink(json: boolean): Sink {
	return json ? jsonSink() : textSink();
}
