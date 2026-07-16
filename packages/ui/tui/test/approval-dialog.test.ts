import assert from "node:assert";
import { describe, it } from "vitest";
import { ApprovalDialog, type ToolCallInfo } from "../src/components/approval-dialog.js";

const testTheme = {
	border: (s: string) => s,
	title: (s: string) => s,
	body: (s: string) => s,
	dim: (s: string) => s,
	highlight: (s: string) => s,
	error: (s: string) => s,
};

const sampleToolCall: ToolCallInfo = {
	toolName: "fs.write",
	args: {
		path: "/etc/passwd",
		content: "malicious content",
	},
	reason: "Attempt to write to protected system file",
};

describe("ApprovalDialog", { tags: ["unit"] }, () => {
	it("renders tool name, reason, and args preview in view mode", () => {
		let actionCalled = false;
		const dialog = new ApprovalDialog({
			toolCall: sampleToolCall,
			theme: testTheme,
			onAction: () => {
				actionCalled = true;
			},
		});

		const rendered = dialog.render(80);

		// Should contain tool name
		assert.ok(rendered.some((line) => line.includes("fs.write")));
		// Should contain reason
		assert.ok(rendered.some((line) => line.includes("protected system file")));
		// Should contain args
		assert.ok(rendered.some((line) => line.includes("/etc/passwd")));
		// Should show keybinding hints
		assert.ok(rendered.some((line) => line.includes("[a] Approve")));
		assert.ok(rendered.some((line) => line.includes("[d] Deny")));
		assert.ok(rendered.some((line) => line.includes("[e] Edit")));

		assert.equal(actionCalled, false);
	});

	it("calls onAction with 'approve' when 'a' is pressed in view mode", () => {
		let capturedAction: string | null = null;
		const dialog = new ApprovalDialog({
			toolCall: sampleToolCall,
			theme: testTheme,
			onAction: (action) => {
				capturedAction = action;
			},
		});

		const handled = dialog.handleInput("a");

		assert.equal(handled, true);
		assert.equal(capturedAction, "approve");
	});

	it("calls onAction with 'deny' when 'd' is pressed in view mode", () => {
		let capturedAction: string | null = null;
		const dialog = new ApprovalDialog({
			toolCall: sampleToolCall,
			theme: testTheme,
			onAction: (action) => {
				capturedAction = action;
			},
		});

		const handled = dialog.handleInput("d");

		assert.equal(handled, true);
		assert.equal(capturedAction, "deny");
	});

	it("calls onAction with 'deny' when Esc is pressed in view mode", () => {
		let capturedAction: string | null = null;
		const dialog = new ApprovalDialog({
			toolCall: sampleToolCall,
			theme: testTheme,
			onAction: (action) => {
				capturedAction = action;
			},
		});

		const handled = dialog.handleInput("\x1b");

		assert.equal(handled, true);
		assert.equal(capturedAction, "deny");
	});

	it("switches to edit mode when 'e' is pressed in view mode", () => {
		const dialog = new ApprovalDialog({
			toolCall: sampleToolCall,
			theme: testTheme,
			onAction: () => {},
		});

		dialog.handleInput("e");

		const rendered = dialog.render(80);

		// Should show edit mode UI
		assert.ok(rendered.some((line) => line.includes("Edit Arguments")));
		assert.ok(rendered.some((line) => line.includes("[Enter] Save")));
		assert.ok(rendered.some((line) => line.includes("[Esc] Cancel")));
	});

	it("returns to view mode when Esc is pressed in edit mode", () => {
		const dialog = new ApprovalDialog({
			toolCall: sampleToolCall,
			theme: testTheme,
			onAction: () => {},
		});

		// Enter edit mode
		dialog.handleInput("e");
		let rendered = dialog.render(80);
		assert.ok(rendered.some((line) => line.includes("Edit Arguments")));

		// Press Esc to cancel
		dialog.handleInput("\x1b");
		rendered = dialog.render(80);

		// Should be back in view mode
		assert.ok(rendered.some((line) => line.includes("[a] Approve")));
		assert.ok(!rendered.some((line) => line.includes("Edit Arguments")));
	});

	it("validates JSON and calls onAction with edited args when Enter is pressed in edit mode", () => {
		let capturedAction: string | null = null;
		let capturedArgs: Record<string, unknown> | undefined;
		const dialog = new ApprovalDialog({
			toolCall: sampleToolCall,
			theme: testTheme,
			onAction: (action, args) => {
				capturedAction = action;
				capturedArgs = args;
			},
		});

		// Enter edit mode
		dialog.handleInput("e");

		// Set valid JSON
		dialog.setEditBuffer('{"path": "/tmp/safe.txt", "content": "safe"}');

		// Press Enter to save
		dialog.handleInput("\r");

		assert.equal(capturedAction, "approve");
		assert.deepEqual(capturedArgs, { path: "/tmp/safe.txt", content: "safe" });
	});

	it("shows error message when invalid JSON is submitted in edit mode", () => {
		const dialog = new ApprovalDialog({
			toolCall: sampleToolCall,
			theme: testTheme,
			onAction: () => {},
		});

		// Enter edit mode
		dialog.handleInput("e");

		// Set invalid JSON
		dialog.setEditBuffer("{invalid json");

		// Press Enter to save
		dialog.handleInput("\r");

		const rendered = dialog.render(80);

		// Should show error message
		assert.ok(rendered.some((line) => line.includes("Error:")));
	});

	it("rejects non-object JSON in edit mode", () => {
		const dialog = new ApprovalDialog({
			toolCall: sampleToolCall,
			theme: testTheme,
			onAction: () => {},
		});

		// Enter edit mode
		dialog.handleInput("e");

		// Set array instead of object
		dialog.setEditBuffer('["not", "an", "object"]');

		// Press Enter to save
		dialog.handleInput("\r");

		const rendered = dialog.render(80);

		// Should show error message
		assert.ok(rendered.some((line) => line.includes("must be a JSON object")));
	});

	it("handles backspace to delete characters in edit mode", () => {
		const dialog = new ApprovalDialog({
			toolCall: sampleToolCall,
			theme: testTheme,
			onAction: () => {},
		});

		// Enter edit mode
		dialog.handleInput("e");

		const initialBuffer = dialog.getEditBuffer();
		const initialLength = initialBuffer.length;

		// Press backspace
		dialog.handleInput("\x7f");

		const newBuffer = dialog.getEditBuffer();

		assert.equal(newBuffer.length, initialLength - 1);
		assert.equal(newBuffer, initialBuffer.slice(0, -1));
	});

	it("accepts case-insensitive keybindings in view mode", () => {
		let capturedActions: string[] = [];
		const makeDialog = () =>
			new ApprovalDialog({
				toolCall: sampleToolCall,
				theme: testTheme,
				onAction: (action) => {
					capturedActions.push(action);
				},
			});

		// Test uppercase A
		let dialog = makeDialog();
		dialog.handleInput("A");
		assert.equal(capturedActions[capturedActions.length - 1], "approve");

		// Test uppercase D
		dialog = makeDialog();
		dialog.handleInput("D");
		assert.equal(capturedActions[capturedActions.length - 1], "deny");

		// Test uppercase E switches to edit mode
		dialog = makeDialog();
		dialog.handleInput("E");
		const rendered = dialog.render(80);
		assert.ok(rendered.some((line) => line.includes("Edit Arguments")));
	});
});
