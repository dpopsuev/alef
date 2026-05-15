/**
 * Legacy discourse adapter — brownfield compat only.
 * Not a CorpusOrgan. Use DialogOrgan for the message bus boundary.
 */
import type { AgentDiscoursePort, DialogDiscoursePort } from "@dpopsuev/alef-discourse";

export type { DialogDiscoursePort } from "@dpopsuev/alef-discourse";

export function createDialogDiscoursePort(discourse: AgentDiscoursePort): DialogDiscoursePort {
	return discourse as unknown as DialogDiscoursePort;
}
