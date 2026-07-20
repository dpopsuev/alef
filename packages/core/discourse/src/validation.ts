import { z } from "zod";
import { IDENTIFIER_MAX_LENGTH, POST_REFERENCE_MAX_COUNT } from "./constants.js";
import type { AppendPostCommand } from "./types.js";

const identifier = z.string().trim().min(1).max(IDENTIFIER_MAX_LENGTH);
const artifactReference = z.object({ kind: identifier, id: identifier }).strict();
const appendPostCommand = z
	.object({
		schemaVersion: z.literal("discourse.command.v1"),
		operationId: identifier,
		forumId: identifier,
		topicId: identifier,
		threadId: identifier,
		authorId: identifier,
		content: z.json(),
		correlationId: identifier.optional(),
		causationId: identifier.optional(),
		replyToPostId: identifier.optional(),
		references: z.array(artifactReference).max(POST_REFERENCE_MAX_COUNT).optional(),
	})
	.strict();

/** Validate and normalize one untrusted append command. */
export function parseAppendPostCommand(input: unknown): AppendPostCommand {
	return appendPostCommand.parse(input);
}
