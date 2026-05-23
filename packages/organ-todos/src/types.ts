export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	/** Present-continuous form shown in TUI: "Running tests", "Editing file". */
	activeForm?: string;
}

export interface TodosResult {
	todos: TodoItem[];
	justCompleted: string[];
	justStarted: string | undefined;
	inProgress: number;
	completed: number;
	total: number;
}
