/**
 * Utilities for splitting a unified AgentDiscoursePort into dialog and monolog
 * projection ports. In the current architecture both projections share the same
 * underlying store; the split is a view boundary, not a data boundary.
 */
import type { AgentDiscoursePort } from "./types.js";

/** Projection of AgentDiscoursePort for interactive dialog (user-facing threads). */
export type DialogDiscoursePort = AgentDiscoursePort;

/** Projection of AgentDiscoursePort for background monolog (cognition artifacts). */
export type MonologDiscoursePort = AgentDiscoursePort;

export interface SplitDiscourseOrgans {
	dialog: DialogDiscoursePort;
	monolog: MonologDiscoursePort;
}

/**
 * Split a unified discourse port into dialog and monolog views.
 * Both views delegate to the same underlying store.
 */
export function splitDiscourseOrgans(discourse: AgentDiscoursePort): SplitDiscourseOrgans {
	return { dialog: discourse, monolog: discourse };
}

/** Wrap an AgentDiscoursePort as a DialogDiscoursePort. Identity function — types are compatible. */
export function createDialogDiscoursePort(discourse: AgentDiscoursePort): DialogDiscoursePort {
	return discourse;
}

/** Wrap an AgentDiscoursePort as a MonologDiscoursePort. Identity function — types are compatible. */
export function createMonologDiscoursePort(discourse: AgentDiscoursePort): MonologDiscoursePort {
	return discourse;
}
