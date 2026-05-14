export type SupervisorSlot = "green" | "blue";

export type SupervisorLifecycleStateName = "idle" | "spawn_requested" | "staging_healthy" | "promoted";

export interface SupervisorIdleState {
	name: "idle";
	activeSlot: SupervisorSlot;
}

export interface SupervisorSpawnRequestedState {
	name: "spawn_requested";
	activeSlot: SupervisorSlot;
	stagingSlot: SupervisorSlot;
	updateId: string;
}

export interface SupervisorStagingHealthyState {
	name: "staging_healthy";
	activeSlot: SupervisorSlot;
	stagingSlot: SupervisorSlot;
	updateId: string;
}

/** Staging has been promoted. The old active slot is tracked as retiringSlot until retire_old is issued. */
export interface SupervisorPromotedState {
	name: "promoted";
	/** The now-active slot (formerly staging). */
	activeSlot: SupervisorSlot;
	/** The old active slot awaiting retirement. */
	retiringSlot: SupervisorSlot;
	updateId: string;
}

export type SupervisorLifecycleState =
	| SupervisorIdleState
	| SupervisorSpawnRequestedState
	| SupervisorStagingHealthyState
	| SupervisorPromotedState;

export type SupervisorLifecycleCommand =
	| {
			type: "spawn_staging";
			commandId: string;
			updateId: string;
			stagingSlot: SupervisorSlot;
	  }
	| {
			type: "mark_staging_healthy";
			commandId: string;
			updateId: string;
	  }
	| {
			type: "promote";
			commandId: string;
			updateId: string;
	  }
	| {
			type: "rollback";
			commandId: string;
			updateId: string;
			reason: string;
	  }
	| {
			type: "abort";
			commandId: string;
			updateId: string;
			reason: string;
	  }
	| {
			/** Finalise retirement of the old slot after a successful promote. Transitions promoted → idle. */
			type: "retire_old";
			commandId: string;
			updateId: string;
	  };

export type SupervisorLifecycleDiagnosticCode = "invalid_transition" | "update_id_mismatch";

export interface SupervisorLifecycleDiagnostic {
	code: SupervisorLifecycleDiagnosticCode;
	command: SupervisorLifecycleCommand["type"];
	state: SupervisorLifecycleStateName;
	reason: string;
	updateId?: string;
	expectedUpdateId?: string;
}

export interface SupervisorTransitionResult {
	accepted: boolean;
	replayed: boolean;
	command: SupervisorLifecycleCommand;
	from: SupervisorLifecycleState;
	to: SupervisorLifecycleState;
	diagnostics: SupervisorLifecycleDiagnostic[];
}

interface CachedCommandResult {
	commandId: string;
	result: SupervisorTransitionResult;
	stateAfter: SupervisorLifecycleState;
}

function cloneState(state: SupervisorLifecycleState): SupervisorLifecycleState {
	return structuredClone(state);
}

function oppositeSlot(slot: SupervisorSlot): SupervisorSlot {
	return slot === "green" ? "blue" : "green";
}

function validateUpdateId(
	state: SupervisorLifecycleState,
	command: SupervisorLifecycleCommand,
): SupervisorLifecycleDiagnostic | undefined {
	if (state.name === "idle") {
		return undefined;
	}
	if (state.updateId === command.updateId) {
		return undefined;
	}
	return {
		code: "update_id_mismatch",
		command: command.type,
		state: state.name,
		reason: `Expected update_id ${state.updateId} but received ${command.updateId}.`,
		updateId: command.updateId,
		expectedUpdateId: state.updateId,
	};
}

export class SupervisorLifecycleMachine {
	private state: SupervisorLifecycleState = {
		name: "idle",
		activeSlot: "green",
	};
	private readonly commandHistory = new Map<string, CachedCommandResult>();

	constructor(initialState?: SupervisorLifecycleState) {
		if (initialState) {
			this.state = cloneState(initialState);
		}
	}

	getState(): SupervisorLifecycleState {
		return cloneState(this.state);
	}

	apply(command: SupervisorLifecycleCommand): SupervisorTransitionResult {
		const cached = this.commandHistory.get(command.commandId);
		if (cached) {
			return {
				...cached.result,
				replayed: true,
				from: cloneState(cached.result.from),
				to: cloneState(cached.result.to),
			};
		}

		const from = cloneState(this.state);
		const diagnostics: SupervisorLifecycleDiagnostic[] = [];
		const mismatchDiagnostic = validateUpdateId(this.state, command);
		if (mismatchDiagnostic) {
			diagnostics.push(mismatchDiagnostic);
			const rejected = {
				accepted: false,
				replayed: false,
				command,
				from,
				to: from,
				diagnostics,
			} satisfies SupervisorTransitionResult;
			this.commandHistory.set(command.commandId, {
				commandId: command.commandId,
				result: rejected,
				stateAfter: cloneState(this.state),
			});
			return rejected;
		}

		let nextState: SupervisorLifecycleState | undefined;
		switch (command.type) {
			case "spawn_staging":
				if (this.state.name !== "idle") {
					diagnostics.push({
						code: "invalid_transition",
						command: command.type,
						state: this.state.name,
						reason: `Cannot spawn staging from state ${this.state.name}.`,
						updateId: command.updateId,
					});
					break;
				}
				nextState = {
					name: "spawn_requested",
					activeSlot: this.state.activeSlot,
					stagingSlot: command.stagingSlot,
					updateId: command.updateId,
				};
				break;
			case "mark_staging_healthy":
				if (this.state.name !== "spawn_requested") {
					diagnostics.push({
						code: "invalid_transition",
						command: command.type,
						state: this.state.name,
						reason: `Cannot mark staging healthy from state ${this.state.name}.`,
						updateId: command.updateId,
					});
					break;
				}
				nextState = {
					name: "staging_healthy",
					activeSlot: this.state.activeSlot,
					stagingSlot: this.state.stagingSlot,
					updateId: this.state.updateId,
				};
				break;
			case "promote":
				if (this.state.name !== "staging_healthy") {
					diagnostics.push({
						code: "invalid_transition",
						command: command.type,
						state: this.state.name,
						reason: `Cannot promote from state ${this.state.name}.`,
						updateId: command.updateId,
					});
					break;
				}
				// staging_healthy → promoted: flip the active slot, record the retiring slot.
				nextState = {
					name: "promoted",
					activeSlot: this.state.stagingSlot,
					retiringSlot: this.state.activeSlot,
					updateId: this.state.updateId,
				};
				break;
			case "retire_old":
				if (this.state.name !== "promoted") {
					diagnostics.push({
						code: "invalid_transition",
						command: command.type,
						state: this.state.name,
						reason: `Cannot retire_old from state ${this.state.name}.`,
						updateId: command.updateId,
					});
					break;
				}
				// promoted → idle: retirement complete, update cycle closed.
				nextState = {
					name: "idle",
					activeSlot: this.state.activeSlot,
				};
				break;
			case "rollback":
			case "abort":
				if (this.state.name === "idle") {
					diagnostics.push({
						code: "invalid_transition",
						command: command.type,
						state: this.state.name,
						reason: `Cannot ${command.type} from state ${this.state.name}.`,
						updateId: command.updateId,
					});
					break;
				}
				// From promoted: the slot was already flipped — restore the retiring slot.
				// From spawn_requested/staging_healthy: slot was never flipped, keep activeSlot.
				nextState = {
					name: "idle",
					activeSlot: this.state.name === "promoted" ? this.state.retiringSlot : this.state.activeSlot,
				};
				break;
		}

		const accepted = diagnostics.length === 0 && !!nextState;
		if (nextState) {
			this.state = cloneState(nextState);
		}
		const to = cloneState(this.state);
		const result = {
			accepted,
			replayed: false,
			command,
			from,
			to,
			diagnostics,
		} satisfies SupervisorTransitionResult;
		this.commandHistory.set(command.commandId, {
			commandId: command.commandId,
			result,
			stateAfter: cloneState(this.state),
		});
		return result;
	}

	nextStagingSlot(): SupervisorSlot {
		return oppositeSlot(this.state.activeSlot);
	}
}
