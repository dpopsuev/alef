/**
 * ExecutionStrategy — the universal agent interface.
 *
 * Every execution path that takes text input and produces a string reply
 * satisfies this interface: the main agent turn, in-process subagents,
 * child process agents, and future A2A peers.
 *
 * The shape already existed five times independently before being named:
 *   DialogOrgan.send       organ-dialog:225
 *   runMetaAgent           runner/src/meta-agent:24
 *   ScenarioContext.send   eval/src/harness:67
 *   BlueprintHarness.send  testkit/src/blueprint-harness:130
 *   BlueprintGauntlet.send testkit/src/blueprint-gauntlet:109
 */

export interface ExecutionStrategy {
	send(text: string, sender?: string, timeoutMs?: number, onChunk?: (chunk: string) => void): Promise<string>;
	dispose?(): void;
}
