import type { LectorClient, OperationInputs, OperationName, OperationOutputs } from "@danypops/lector";

/** Records every call made through it and returns a scripted response per operation name. */
export function createFakeLectorClient(responses: Partial<{ [Name in OperationName]: OperationOutputs[Name] }>): {
	client: LectorClient;
	calls: Array<{ operation: OperationName; input: unknown }>;
} {
	const calls: Array<{ operation: OperationName; input: unknown }> = [];
	const client = {
		call: async <Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]> => {
			calls.push({ operation, input });
			const response = responses[operation];
			if (response === undefined) throw new Error(`no scripted response for operation "${operation}"`);
			return response as OperationOutputs[Name];
		},
		operations: async () => Object.keys(responses) as OperationName[],
		ready: async () => true,
		health: async () => ({ ok: true as const, version: "test" }),
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test double narrowly covers only the methods callLector actually exercises
	} as unknown as LectorClient;
	return { client, calls };
}
