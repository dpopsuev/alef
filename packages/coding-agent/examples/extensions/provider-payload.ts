import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@alf-agent/coding-agent";

export default function (alf: ExtensionAPI) {
	const logFile = join(process.cwd(), ".pi", "provider-payload.log");

	alf.on("before_provider_request", (event) => {
		appendFileSync(logFile, `${JSON.stringify(event.payload, null, 2)}\n\n`, "utf8");

		// Optional: replace the payload instead of only logging it.
		// return { ...event.payload, temperature: 0 };
	});

	alf.on("after_provider_response", (event) => {
		appendFileSync(logFile, `[${event.status}] ${JSON.stringify(event.headers)}\n\n`, "utf8");
	});
}
