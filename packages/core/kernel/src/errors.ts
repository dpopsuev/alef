/**
 * Centralized error handling utilities for Alef.
 *
 * This module provides:
 * - Standard error classes with context preservation
 * - Error normalization and formatting
 * - Stack trace handling
 * - Type-safe error conversion
 */

/** Base context type for all Alef errors */
export interface ErrorContext {
	[key: string]: unknown;
}

/**
 * Base class for all Alef errors.
 * Preserves error name, stack trace, and structured context.
 */
export class AlefError extends Error {
	readonly context: ErrorContext;
	readonly timestamp: number;

	constructor(message: string, context: ErrorContext = {}) {
		super(message);
		this.name = this.constructor.name;
		this.context = context;
		this.timestamp = Date.now();

		// Preserve stack trace in V8 engines
		Error.captureStackTrace(this, this.constructor);
	}

	/** Serialize error to structured log format */
	toLogObject(): Record<string, unknown> {
		return {
			name: this.name,
			message: this.message,
			context: this.context,
			timestamp: this.timestamp,
			stack: this.stack,
		};
	}
}

/** Timeout-related errors (operation exceeded time limit) */
export class TimeoutError extends AlefError {
	constructor(message: string, context: ErrorContext = {}) {
		super(message, context);
	}
}

/** Validation errors (invalid input, schema mismatch, type errors) */
export class ValidationError extends AlefError {
	readonly validationErrors?: unknown[];

	constructor(message: string, context: ErrorContext = {}, validationErrors?: unknown[]) {
		super(message, context);
		this.validationErrors = validationErrors;
	}
}

/** Resource not found errors (file, session, adapter, tool) */
export class NotFoundError extends AlefError {
	readonly resourceType: string;
	readonly resourceId: string;

	constructor(resourceType: string, resourceId: string, context: ErrorContext = {}) {
		super(`${resourceType} not found: ${resourceId}`, context);
		this.resourceType = resourceType;
		this.resourceId = resourceId;
	}
}

/** Permission or security constraint violations */
export class PermissionError extends AlefError {
	readonly operation: string;
	readonly resource: string;

	constructor(operation: string, resource: string, context: ErrorContext = {}) {
		super(`Permission denied: ${operation} on ${resource}`, context);
		this.operation = operation;
		this.resource = resource;
	}
}

/** Rate limiting or quota exceeded */
export class RateLimitError extends AlefError {
	readonly retryAfter?: number; // milliseconds

	constructor(message: string, context: ErrorContext = {}, retryAfter?: number) {
		super(message, context);
		this.retryAfter = retryAfter;
	}
}

/** External service or network failures */
export class ServiceError extends AlefError {
	readonly service: string;
	readonly statusCode?: number;
	readonly isRetriable: boolean;

	constructor(service: string, message: string, context: ErrorContext = {}, statusCode?: number, isRetriable = false) {
		super(message, context);
		this.service = service;
		this.statusCode = statusCode;
		this.isRetriable = isRetriable;
	}
}

/** Configuration errors (missing env vars, invalid blueprint) */
export class ConfigurationError extends AlefError {
	readonly configKey: string;

	constructor(configKey: string, message: string, context: ErrorContext = {}) {
		super(message, context);
		this.configKey = configKey;
	}
}

/** Errors occurring during adapter init, mount, unmount, or execution phases. */
export class AdapterError extends AlefError {
	readonly adapterName: string;
	readonly phase: "init" | "mount" | "unmount" | "execute";

	constructor(adapterName: string, phase: AdapterError["phase"], message: string, context: ErrorContext = {}) {
		super(message, context);
		this.adapterName = adapterName;
		this.phase = phase;
	}
}

/**
 * Ensure a caught value is an Error instance.
 * Thrown values that aren't Error objects are wrapped.
 */
export function ensureError(err: unknown): Error {
	if (err instanceof Error) {
		return err;
	}

	// Handle primitive types
	if (typeof err === "string") {
		return new Error(err);
	}

	// Handle objects with message property
	if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
		const error = new Error(err.message);
		// Preserve additional properties
		Object.assign(error, err);
		return error;
	}

	// Last resort: stringify
	return new Error(String(err));
}

/**
 * Extract error message safely from any thrown value.
 * Consistent replacement for: err instanceof Error ? err.message : String(err)
 */
export function getErrorMessage(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	if (typeof err === "string") {
		return err;
	}
	if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
		return err.message;
	}
	return String(err);
}

/**
 * Format error for structured logging.
 * Returns an object suitable for log.error({ err: formatErrorForLog(e) }, "message")
 */
export function formatErrorForLog(err: unknown): Record<string, unknown> {
	const error = ensureError(err);

	const base: Record<string, unknown> = {
		name: error.name,
		message: error.message,
	};

	// Include stack trace in debug mode
	if (process.env.ALEF_DEBUG === "1" && error.stack) {
		base.stack = error.stack;
	}

	// Include AlefError context if available
	if (error instanceof AlefError) {
		base.context = error.context;
		base.timestamp = error.timestamp;
	}

	// Include cause chain if available (Node 16.9+)
	if (error.cause) {
		base.cause = formatErrorForLog(error.cause);
	}

	return base;
}

/**
 * Format error for display to end users.
 * Sanitizes internal details, provides actionable messages.
 */
export function formatErrorForUser(err: unknown): string {
	const message = getErrorMessage(err);

	// Timeout errors
	if (err instanceof TimeoutError || message.includes("timed out") || message.includes("timeout")) {
		return "Request timed out. The operation took too long. Try again or increase timeout settings.";
	}

	// Rate limit errors
	if (err instanceof RateLimitError || message.includes("429") || message.toLowerCase().includes("rate limit")) {
		const retryAfter =
			// eslint-disable-next-line no-magic-numbers
			err instanceof RateLimitError && err.retryAfter ? ` (retry in ${Math.ceil(err.retryAfter / 1000)}s)` : "";
		return `Rate limited. Wait a moment and try again${retryAfter}.`;
	}

	// Context too long (common LLM error)
	if (message.includes("context") && message.includes("long")) {
		return "Context too long. Start a new session or reduce input size.";
	}

	// Session disposal errors
	if (message.includes("unmounted") || message.includes("disposed")) {
		return "Agent session ended unexpectedly. Start a new session.";
	}

	// Permission errors
	if (err instanceof PermissionError) {
		return `Permission denied: ${err.operation} on ${err.resource}`;
	}

	// Not found errors
	if (err instanceof NotFoundError) {
		return `${err.resourceType} not found: ${err.resourceId}`;
	}

	// Service errors with retry guidance
	if (err instanceof ServiceError) {
		const retryMsg = err.isRetriable ? " The operation can be retried." : "";
		return `${err.service} error: ${message}${retryMsg}`;
	}

	// Configuration errors
	if (err instanceof ConfigurationError) {
		return `Configuration error (${err.configKey}): ${message}`;
	}

	// Generic message with debug hint
	if (process.env.ALEF_DEBUG === "1" && err instanceof Error && err.stack) {
		return `${message}\n${err.stack}`;
	}

	return message;
}

/**
 * Wrap an error with additional context.
 * Preserves the original error as the cause (Node 16.9+).
 */
export function wrapError(err: unknown, message: string, context: ErrorContext = {}): AlefError {
	const originalError = ensureError(err);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- widen to include cause (Node 16.9+ Error property)
	const wrappedError = new AlefError(message, context) as AlefError & { cause: Error };
	wrappedError.cause = originalError;
	return wrappedError;
}

/**
 * Check if an error is retriable based on its type and properties.
 */
export function isRetriable(err: unknown): boolean {
	if (err instanceof ServiceError) {
		return err.isRetriable;
	}

	// Network errors are often retriable
	const message = getErrorMessage(err);
	if (
		message.includes("ECONNRESET") ||
		message.includes("ETIMEDOUT") ||
		message.includes("ENOTFOUND") ||
		message.includes("ECONNREFUSED")
	) {
		return true;
	}

	// 5xx server errors are retriable
	// eslint-disable-next-line no-magic-numbers
	if (err instanceof ServiceError && err.statusCode && err.statusCode >= 500 && err.statusCode < 600) {
		return true;
	}

	// 429 rate limit is retriable
	if (err instanceof RateLimitError || message.includes("429")) {
		return true;
	}

	return false;
}

/**
 * Create a structured error object for the event bus.
 * Compatible with existing buildErrorResult() pattern.
 */
export function toSenseError(err: unknown): { message: string; error: Record<string, unknown> } {
	return {
		message: getErrorMessage(err),
		error: formatErrorForLog(err),
	};
}
