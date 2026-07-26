import type { ZodTypeAny, z } from "zod";

/** Classifies whether a command crosses the runtime's external-effect boundary. */
export type CapabilityEffect = "none" | "external";

/** Keeps command failures machine-actionable across transports. */
export type CapabilityCommandErrorCode =
	| "duplicate-owner"
	| "not-found"
	| "invalid-input"
	| "invalid-output"
	| "permission-denied"
	| "cancelled"
	| "deadline-exceeded"
	| "handler-failed";

/** Preserves a stable failure code without leaking handler exceptions. */
export class CapabilityCommandError extends Error {
	constructor(
		readonly code: CapabilityCommandErrorCode,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "CapabilityCommandError";
	}
}

/** Pins command identity to the schemas and permissions its owner accepts. */
export interface CapabilityCommand<TInputSchema extends ZodTypeAny, TOutputSchema extends ZodTypeAny> {
	readonly name: string;
	readonly version: number;
	readonly input: TInputSchema;
	readonly output: TOutputSchema;
	readonly permissions: readonly string[];
	readonly effect: CapabilityEffect;
}

/** Freezes command identity before materialization checks ownership. */
export function defineCommand<TInputSchema extends ZodTypeAny, TOutputSchema extends ZodTypeAny>(definition: {
	name: string;
	version: number;
	input: TInputSchema;
	output: TOutputSchema;
	permissions?: readonly string[];
	effect?: CapabilityEffect;
}): CapabilityCommand<TInputSchema, TOutputSchema> {
	if (!definition.name.trim()) throw new Error("command name must not be empty");
	if (!Number.isInteger(definition.version) || definition.version < 1) {
		throw new Error("command version must be a positive integer");
	}
	return Object.freeze({
		...definition,
		permissions: Object.freeze([...(definition.permissions ?? [])]),
		effect: definition.effect ?? "none",
	});
}

/** Carries caller authority and lifetime across the command boundary. */
export interface CommandExecutionOptions {
	readonly signal?: AbortSignal;
	readonly deadline?: number;
	readonly permissions?: readonly string[];
	readonly correlationId?: string;
	readonly runId?: string;
	readonly toolCallId?: string;
	readonly effectProposalId?: string;
	readonly onProgress?: (progress: Record<string, unknown>) => void;
}

/** Gives the owner validated input and the caller's effective lifetime. */
export interface CommandHandlerContext<TInput> {
	readonly input: TInput;
	readonly signal: AbortSignal;
	readonly deadline?: number;
	readonly correlationId?: string;
	readonly runId?: string;
	readonly toolCallId?: string;
	reportProgress(progress: Record<string, unknown>): void;
}

/** Keeps command execution independent from its in-process or RPC transport. */
export type CommandHandler<TInput, TOutput> = (context: CommandHandlerContext<TInput>) => Promise<TOutput>;

/** Gives policy the validated command request and caller authority. */
export interface CapabilityExecutionRequest {
	readonly command: AnyCapabilityCommand;
	readonly input: unknown;
	readonly options: CommandExecutionOptions;
}

/** Governs validated command execution without wrapping transport channels. */
export interface CapabilityExecutionPolicy {
	execute(request: CapabilityExecutionRequest, invoke: (input: unknown) => Promise<unknown>): Promise<unknown>;
}

/** Preserves machine-actionable policy failures across command transports. */
export class CapabilityExecutionPolicyError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "CapabilityExecutionPolicyError";
	}
}

/** Erases schema generics only after contracts retain their runtime validators. */
export type AnyCapabilityCommand = CapabilityCommand<ZodTypeAny, ZodTypeAny>;

/** Creates session-local command handling state from an adapter declaration. */
export interface CommandBinding {
	readonly command: AnyCapabilityCommand;
	bind(): CommandHandler<unknown, unknown>;
}

type Registration = {
	readonly owner: string;
	readonly command: AnyCapabilityCommand;
	invoke(input: unknown, context: Omit<CommandHandlerContext<unknown>, "input">): Promise<unknown>;
};

/** Keeps different contract versions independently ownable. */
function commandKey(name: string, version: number): string {
	return `${name}@${version}`;
}

/** Distinguishes an expired deadline from caller cancellation. */
function abortFailure(signal: AbortSignal, deadline?: number): CapabilityCommandError {
	if (deadline !== undefined && Date.now() >= deadline) {
		return new CapabilityCommandError("deadline-exceeded", `command deadline exceeded at ${deadline}`);
	}
	return new CapabilityCommandError("cancelled", "command cancelled", { cause: signal.reason });
}

/** Stops the caller from waiting on a non-cooperative handler. */
async function awaitWithSignal<T>(operation: Promise<T>, signal: AbortSignal, deadline?: number): Promise<T> {
	if (signal.aborted) throw abortFailure(signal, deadline);
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(abortFailure(signal, deadline));
		signal.addEventListener("abort", onAbort, { once: true });
		void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/** Enforces one validated owner for every command name and version. */
export class CommandRouter {
	private readonly registrations = new Map<string, Registration>();

	constructor(private executionPolicy?: CapabilityExecutionPolicy) {}

	setExecutionPolicy(policy: CapabilityExecutionPolicy): void {
		if (this.executionPolicy) throw new Error("command execution policy is already configured");
		this.executionPolicy = policy;
	}

	register<TInputSchema extends ZodTypeAny, TOutputSchema extends ZodTypeAny>(
		owner: string,
		command: CapabilityCommand<TInputSchema, TOutputSchema>,
		handler: CommandHandler<z.infer<TInputSchema>, z.infer<TOutputSchema>>,
	): void {
		this.addRegistration(owner, command, (input, context) => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Input was parsed by this command's schema before invocation.
			return handler({ ...context, input: input as z.infer<TInputSchema> });
		});
	}

	registerBinding(owner: string, binding: CommandBinding): void {
		const handler = binding.bind();
		this.addRegistration(owner, binding.command, (input, context) => handler({ ...context, input }));
	}

	ownerOf(command: AnyCapabilityCommand): string | undefined {
		return this.registrations.get(commandKey(command.name, command.version))?.owner;
	}

	execute<TInputSchema extends ZodTypeAny, TOutputSchema extends ZodTypeAny>(
		command: CapabilityCommand<TInputSchema, TOutputSchema>,
		input: z.input<TInputSchema>,
		options: CommandExecutionOptions = {},
	): Promise<z.output<TOutputSchema>> {
		return this.executeRegistration(commandKey(command.name, command.version), input, options).then((output) => {
			const parsed = command.output.safeParse(output);
			if (!parsed.success) {
				throw new CapabilityCommandError("invalid-output", `${command.name}@${command.version} returned invalid output`);
			}
			return parsed.data;
		});
	}

	executeByName(
		name: string,
		version: number,
		input: unknown,
		options: CommandExecutionOptions = {},
	): Promise<unknown> {
		return this.executeRegistration(commandKey(name, version), input, options);
	}

	private addRegistration(
		owner: string,
		command: AnyCapabilityCommand,
		invoke: Registration["invoke"],
	): void {
		if (!owner.trim()) throw new Error("command owner must not be empty");
		const key = commandKey(command.name, command.version);
		const existing = this.registrations.get(key);
		if (existing) {
			throw new CapabilityCommandError(
				"duplicate-owner",
				`${key} is already owned by ${existing.owner}; ${owner} cannot also register it`,
			);
		}
		this.registrations.set(key, { owner, command, invoke });
	}

	private async executeRegistration(
		key: string,
		input: unknown,
		options: CommandExecutionOptions,
	): Promise<unknown> {
		const registration = this.registrations.get(key);
		if (!registration) throw new CapabilityCommandError("not-found", `no owner registered for ${key}`);

		const granted = new Set(options.permissions ?? []);
		const missing = registration.command.permissions.filter((permission) => !granted.has(permission));
		if (missing.length > 0) {
			throw new CapabilityCommandError("permission-denied", `${key} requires permissions: ${missing.join(", ")}`);
		}

		const parsedInput = registration.command.input.safeParse(input);
		if (!parsedInput.success) throw new CapabilityCommandError("invalid-input", `${key} received invalid input`);
		if (options.deadline !== undefined && options.deadline <= Date.now()) {
			throw new CapabilityCommandError("deadline-exceeded", `${key} deadline has already elapsed`);
		}

		const signals: AbortSignal[] = [];
		if (options.signal) signals.push(options.signal);
		if (options.deadline !== undefined) signals.push(AbortSignal.timeout(Math.max(1, options.deadline - Date.now())));
		const signal = signals.length === 0 ? new AbortController().signal : AbortSignal.any(signals);
		const context: Omit<CommandHandlerContext<unknown>, "input"> = {
			signal,
			deadline: options.deadline,
			correlationId: options.correlationId,
			runId: options.runId,
			toolCallId: options.toolCallId,
			reportProgress: (progress) => options.onProgress?.(progress),
		};

		const invoke = async (candidate: unknown): Promise<unknown> => {
			const effectiveInput = registration.command.input.safeParse(candidate);
			if (!effectiveInput.success) throw new CapabilityCommandError("invalid-input", `${key} received invalid effective input`);
			try {
				return await registration.invoke(effectiveInput.data, context);
			} catch (error) {
				if (error instanceof CapabilityCommandError || error instanceof CapabilityExecutionPolicyError) throw error;
				if (signal.aborted) throw abortFailure(signal, options.deadline);
				throw new CapabilityCommandError("handler-failed", `${key} handler failed`, { cause: error });
			}
		};
		const operation = this.executionPolicy
			? this.executionPolicy.execute({ command: registration.command, input: parsedInput.data, options }, invoke)
			: invoke(parsedInput.data);
		const output = await awaitWithSignal(operation, signal, options.deadline);
		const parsedOutput = registration.command.output.safeParse(output);
		if (!parsedOutput.success) throw new CapabilityCommandError("invalid-output", `${key} returned invalid output`);
		return parsedOutput.data;
	}
}
