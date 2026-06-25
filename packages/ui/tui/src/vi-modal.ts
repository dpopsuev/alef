import { matchesKey } from "./keys.js";

export type ViMode = "normal" | "insert";

export interface ViModalOptions {
	onModeChange?: (mode: ViMode) => void;
	insertTriggers?: string[];
}

export class ViModal {
	private _mode: ViMode = "normal";
	private onModeChange?: (mode: ViMode) => void;
	private insertTriggers: Set<string>;

	constructor(opts: ViModalOptions = {}) {
		this.onModeChange = opts.onModeChange;
		this.insertTriggers = new Set(opts.insertTriggers ?? ["i", "/"]);
	}

	get mode(): ViMode {
		return this._mode;
	}

	isNormal(): boolean {
		return this._mode === "normal";
	}

	isInsert(): boolean {
		return this._mode === "insert";
	}

	enterInsert(): void {
		if (this._mode === "insert") return;
		this._mode = "insert";
		this.onModeChange?.("insert");
	}

	enterNormal(): void {
		if (this._mode === "normal") return;
		this._mode = "normal";
		this.onModeChange?.("normal");
	}

	handleKey(key: string): "mode-change" | "passthrough" {
		if (this._mode === "insert") {
			if (matchesKey(key, "escape")) {
				this.enterNormal();
				return "mode-change";
			}
			return "passthrough";
		}

		if (this.insertTriggers.has(key)) {
			this.enterInsert();
			return "mode-change";
		}

		return "passthrough";
	}
}
