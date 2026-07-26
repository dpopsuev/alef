import type { ZodTypeAny, z } from "zod";

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
}

/** Freezes command identity before materialization checks ownership. */
export function defineCommand<TInputSchema extends ZodTypeAny, TOutputSchema extends ZodTypeAny>(definition: {
	name: string;
	version: number;
	input: TInputSchema;
	output: TOutputSchema;
	permissions?: readonly string[];
}): CapabilityCommand<TInputSchema, TOutputSchema> {
	if (!definition.name.trim()) throw new Error("command name must not be empty");
	if (!Number.isInteger(definition.version) || definition.version < 1) {
		throw new Error("command version must be a positive integer");
	}
	return Object.freeze({ ...definition, permissions: Object.freeze([...(definition.permissions ?? [])]) });
}

/** Carries caller authority and lifetime across the command boundary. */
export interface CommandExecutionOptions {
	readonly signal?: AbortSignal;
	readonly deadline?: number;
	readonly permissions?: readonly string[];
	readonly correlationId?: string;
	readonly runId?: string;
	readonly onProgress?: (progress: Record<string, unknown>) => void;
}

/** Gives the owner validated input and the caller's effective lifetime. */
export interface CommandHandlerContext<TInput> {
	readonly input: TInput;
	readonly signal: AbortSignal;
	readonly deadline?: number;
	readonly correlationId?: string;
	readonly runId?: string;
	reportProgress(progress: Record<string, unknown>): void;
}

/** Keeps command execution independent from its in-process or RPC transport. */
export type CommandHandler<TInput, TOutput> = (context: CommandHandlerContext<TInput>) => Promise<TOutput>;

type AnyCommand = CapabilityCommand<ZodTypeAny, ZodTypeAny>;
type Registration = {
	readonly owner: string;
	readonly command: AnyCommand;
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

	register<TInputSchema extends ZodTypeAny, TOutputSchema extends ZodTypeAny>(
		owner: string,
		command: CapabilityCommand<TInputSchema, TOutputSchema>,
		handler: CommandHandler<z.infer<TInputSchema>, z.infer<TOutputSchema>>,
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
		this.registrations.set(key, {
			owner,
			command,
			invoke(input, context) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Input was parsed by this command's schema before invocation.
				return handler({ ...context, input: input as z.infer<TInputSchema> });
			},
		});
	}

	ownerOf(command: AnyCommand): string | undefined {
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
			reportProgress: (progress) => options.onProgress?.(progress),
		};

		let output: unknown;
		try {
			output = await awaitWithSignal(registration.invoke(parsedInput.data, context), signal, options.deadline);
		} catch (error) {
			if (error instanceof CapabilityCommandError) throw error;
			if (signal.aborted) throw abortFailure(signal, options.deadline);
			throw new CapabilityCommandError("handler-failed", `${key} handler failed`, { cause: error });
		}
		const parsedOutput = registration.command.output.safeParse(output);
		if (!parsedOutput.success) throw new CapabilityCommandError("invalid-output", `${key} returned invalid output`);
		return parsedOutput.data;
	}
}
