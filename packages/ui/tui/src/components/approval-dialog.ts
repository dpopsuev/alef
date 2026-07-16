import type { Component } from "../component.js";
import { matchesKey } from "../keys.js";
import { truncateToWidth } from "../utils.js";

/**
 * Approval state for the dialog component.
 */
export type ApprovalAction = "approve" | "deny" | "edit";

/**
 * Tool call metadata for display in the approval dialog.
 */
export interface ToolCallInfo {
	toolName: string;
	args: Record<string, unknown>;
	reason: string;
}

/**
 * Theme for the approval dialog component.
 */
export interface ApprovalDialogTheme {
	border: (s: string) => string;
	title: (s: string) => string;
	body: (s: string) => string;
	dim: (s: string) => string;
	highlight: (s: string) => string;
	error: (s: string) => string;
}

/**
 * Options for the approval dialog component.
 */
export interface ApprovalDialogOptions {
	toolCall: ToolCallInfo;
	theme: ApprovalDialogTheme;
	onAction: (action: ApprovalAction, editedArgs?: Record<string, unknown>) => void;
}

/**
 * Dialog mode: viewing or editing arguments.
 */
type DialogMode = "view" | "edit";

/**
 * ApprovalDialog component for human-in-the-loop approval gates.
 * 
 * Displays tool name, args preview, and reason for escalation.
 * Keybindings:
 *   a - approve
 *   d - deny
 *   e - edit args (opens JSON editor)
 *   Esc - deny (cancel)
 * 
 * When editing:
 *   Enter - save edits and approve
 *   Esc - cancel edit and return to view
 */
export class ApprovalDialog implements Component {
	private readonly toolCall: ToolCallInfo;
	private readonly theme: ApprovalDialogTheme;
	private readonly onAction: (action: ApprovalAction, editedArgs?: Record<string, unknown>) => void;
	
	private mode: DialogMode = "view";
	private editBuffer: string = "";
	private editError: string | null = null;

	constructor(opts: ApprovalDialogOptions) {
		this.toolCall = opts.toolCall;
		this.theme = opts.theme;
		this.onAction = opts.onAction;
		this.editBuffer = JSON.stringify(opts.toolCall.args, null, 2);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { theme, toolCall, mode } = this;
		const lines: string[] = [];
		const inner = Math.max(10, width - 4);

		// Title
		lines.push(theme.border("─".repeat(width)));
		lines.push(theme.title(`  Approval Required: ${toolCall.toolName}`));
		lines.push("");

		if (mode === "view") {
			// Reason
			lines.push(theme.highlight("  Reason:"));
			for (const line of toolCall.reason.split("\n")) {
				lines.push(theme.body(`  ${truncateToWidth(line, inner, "…")}`));
			}
			lines.push("");

			// Args preview (truncated)
			lines.push(theme.highlight("  Arguments:"));
			const argsPreview = JSON.stringify(toolCall.args, null, 2);
			const previewLines = argsPreview.split("\n").slice(0, 10);
			for (const line of previewLines) {
				lines.push(theme.dim(`  ${truncateToWidth(line, inner, "…")}`));
			}
			if (argsPreview.split("\n").length > 10) {
				lines.push(theme.dim(`  ... (${argsPreview.split("\n").length - 10} more lines)`));
			}
			lines.push("");

			// Keybindings
			const hints = "[a] Approve  [d] Deny  [e] Edit  [Esc] Cancel";
			lines.push(theme.dim(`  ${hints}`));
		} else {
			// Edit mode
			lines.push(theme.highlight("  Edit Arguments (JSON):"));
			lines.push("");

			const editLines = this.editBuffer.split("\n");
			for (const line of editLines.slice(0, 15)) {
				lines.push(theme.body(`  ${truncateToWidth(line, inner, "…")}`));
			}
			if (editLines.length > 15) {
				lines.push(theme.dim(`  ... (${editLines.length - 15} more lines)`));
			}

			if (this.editError) {
				lines.push("");
				lines.push(theme.error(`  Error: ${this.editError}`));
			}

			lines.push("");
			const editHints = "[Enter] Save & Approve  [Esc] Cancel Edit";
			lines.push(theme.dim(`  ${editHints}`));
		}

		lines.push(theme.border("─".repeat(width)));

		return lines;
	}

	handleInput(data: string): boolean {
		if (this.mode === "view") {
			// View mode keybindings
			if (data === "a" || data === "A") {
				this.onAction("approve");
				return true;
			}
			if (data === "d" || data === "D" || data === "\x1b") {
				this.onAction("deny");
				return true;
			}
			if (data === "e" || data === "E") {
				this.mode = "edit";
				this.editError = null;
				return true;
			}
			return false;
		} else {
			// Edit mode keybindings
			if (matchesKey(data, "enter")) {
				// Validate and save edits
				try {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- user-provided JSON, validated below
					const parsed = JSON.parse(this.editBuffer);
					if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
						this.editError = "Arguments must be a JSON object";
						return true;
					}
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated above
					this.onAction("approve", parsed as Record<string, unknown>);
					return true;
				} catch (err) {
					this.editError = err instanceof Error ? err.message : "Invalid JSON";
					return true;
				}
			}
			if (data === "\x1b") {
				// Cancel edit
				this.mode = "view";
				this.editError = null;
				this.editBuffer = JSON.stringify(this.toolCall.args, null, 2);
				return true;
			}

			// Simple text editing (append characters, backspace)
			if (data === "\x7f" || matchesKey(data, "backspace")) {
				if (this.editBuffer.length > 0) {
					this.editBuffer = this.editBuffer.slice(0, -1);
				}
				return true;
			}

			// Printable characters
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.editBuffer += data;
				return true;
			}

			return false;
		}
	}

	/**
	 * Set the edit buffer content programmatically (for external editor integration).
	 */
	setEditBuffer(content: string): void {
		this.editBuffer = content;
		this.editError = null;
	}

	/**
	 * Get the current edit buffer content.
	 */
	getEditBuffer(): string {
		return this.editBuffer;
	}
}
