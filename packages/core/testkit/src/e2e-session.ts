/**
 * createE2eSession — async alias of createHeadlessSession.
 *
 * Kept for caller import stability. Prefer createHeadlessSession for new code.
 *
 * Usage:
 *   import { createE2eSession, HAVE_REAL_LLM } from "@dpopsuev/alef-testkit";
 *
 *   describe.skipIf(!HAVE_REAL_LLM)("adapter-fs real LLM E2E", () => {
 *     it("LLM reads unguessable file", async () => {
 *       const session = await createE2eSession([createFsAdapter({ cwd })]);
 *       const { reply, events } = await session.send("Read secret.txt and tell me the UUID");
 *       expect(reply).toContain(uuid);
 *       await session.dispose();
 *     });
 *   });
 */

import type { Adapter } from "@dpopsuev/alef-kernel/adapter";
import {
	createHeadlessSession,
	HAVE_REAL_LLM,
	type HeadlessResult,
	type HeadlessSession,
	type HeadlessSessionOptions,
} from "./headless-session.js";

export { HAVE_REAL_LLM };

/** @deprecated Prefer HeadlessResult — alias kept for callers. */
export type E2eResult = HeadlessResult;

/** @deprecated Prefer HeadlessSession — alias kept for callers. */
export type E2eSession = HeadlessSession;

/** @deprecated Prefer HeadlessSessionOptions — alias kept for callers. */
export type E2eSessionOptions = HeadlessSessionOptions;

/**
 * Create a real-LLM session mounting the given adapters.
 * Resolves the model from the current process environment via createHeadlessSession.
 */
export async function createE2eSession(
	adapters: Adapter[],
	opts: E2eSessionOptions = {},
): Promise<E2eSession> {
	return createHeadlessSession(adapters, opts);
}
