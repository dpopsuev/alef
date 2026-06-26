import { type TUnsafe, Type } from "typebox";

/**
 * Creates a string enum schema compatible with Google's API and other providers
 * that don't support anyOf/const patterns.
 *
 * @example
 * const OperationSchema = StringEnum(["add", "subtract", "multiply", "divide"], {
 *   description: "The operation to perform"
 * });
 *
 * type Operation = Static<typeof OperationSchema>; // "add" | "subtract" | "multiply" | "divide"
 */
export function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- TypeBox Unsafe schema requires raw enum array
		enum: values as unknown as string[],
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}
