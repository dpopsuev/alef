import type { TranscriptEvent, Validator } from "./types.js";

/**
 * Run structural validators against a transcript.
 * Returns a list of failure messages. Empty = all passed.
 */
export function runValidators(transcript: TranscriptEvent[], validators: Validator[]): string[] {
	const failures: string[] = [];
	const allText = transcript
		.filter((e) => e.text)
		.map((e) => e.text as string)
		.join("\n");

	for (const v of validators) {
		switch (v.type) {
			case "contains":
				if (!allText.includes(v.value)) {
					failures.push(`Expected response to contain "${v.value}"`);
				}
				break;
			case "not_contains":
				if (allText.includes(v.value)) {
					failures.push(`Response must not contain "${v.value}"`);
				}
				break;
			case "tool_called":
				if (!transcript.some((e) => e.bus === "command" && e.type === v.value)) {
					failures.push(`Expected tool "${v.value}" to be called`);
				}
				break;
			case "exit_code":
				// exit_code validator: look for shell.exec event events containing the code
				if (!transcript.some((e) => e.type === "shell.exec" && String(e.text).includes(`"exitCode":${v.value}`))) {
					failures.push(`Expected exit code ${v.value}`);
				}
				break;
		}
	}

	return failures;
}
