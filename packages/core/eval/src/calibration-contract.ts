/**
 * CalibrationContract \u2014 declarative field extraction from adapter Event payloads.
 *
 * Instead of hard-coding field paths in every scorer, a contract declares
 * how adapter output fields map to scorer-addressable names:
 *
 *   { outputs: [{ field: "output.defect_type", scorerName: "actual_defect_type", type: "string" }] }
 *
 * extractFields(contract, payload) resolves dotted paths and array projections.
 * foldContracts(map) namespaces contracts for multi-adapter evals.
 *
 * Mirrors Tako calibrate.CalibrationContract + ExtractFields + FoldContracts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 *
 */
export type ContractFieldType = "string" | "number" | "boolean" | "array" | "object";

/**
 *
 */
export interface ContractField {
	/** Dotted path into the Event payload, e.g. "output.defect_type" or "files[].path". */
	field: string;
	/** Scorer-addressable name, e.g. "actual_defect_type". */
	scorerName: string;
	/** Expected type for documentation and validation. */
	type: ContractFieldType;
}

/**
 *
 */
export interface CalibrationContract {
	inputs?: ContractField[];
	outputs: ContractField[];
}

// ---------------------------------------------------------------------------
// extractFields \u2014 resolve contract outputs from a Event payload
// ---------------------------------------------------------------------------

/**
 * Extract scorer-addressable values from a Event payload using a contract.
 * Returns a flat map keyed by scorerName.
 *
 * @example
 * const fields = extractFields(contract, sensePayload);
 * // fields["actual_defect_type"] = "null_dereference"
 */
export function extractFields(
	contract: CalibrationContract,
	payload: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};

	for (const field of contract.outputs) {
		const val = resolvePath(field.field, payload);
		if (val !== undefined) {
			out[field.scorerName] = val;
		}
	}

	return out;
}

/**
 * Fold multiple named contracts into one with namespace-prefixed scorer names.
 * Enables multi-adapter evals where each adapter's fields are distinguishable.
 *
 * @example
 * const folded = foldContracts({ lector: lectorContract, shell: shellContract });
 * // folded outputs: "lector.actual_symbol", "shell.exit_code"
 */
export function foldContracts(contracts: Record<string, CalibrationContract>): CalibrationContract {
	const keys = Object.keys(contracts);
	if (keys.length === 0) return { outputs: [] };
	if (keys.length === 1) return contracts[keys[0]];

	const foldedInputs: ContractField[] = [];
	const folded: CalibrationContract = { inputs: foldedInputs, outputs: [] };
	for (const [ns, c] of Object.entries(contracts)) {
		for (const inp of c.inputs ?? []) {
			foldedInputs.push({ ...inp, field: `${ns}.${inp.field}`, scorerName: `${ns}.${inp.scorerName}` });
		}
		for (const out of c.outputs) {
			folded.outputs.push({ ...out, field: `${ns}.${out.field}`, scorerName: `${ns}.${out.scorerName}` });
		}
	}
	return folded;
}

// ---------------------------------------------------------------------------
// Path resolution \u2014 dotted paths + array projections
// ---------------------------------------------------------------------------

/**
 *
 */
function resolvePath(path: string, root: unknown): unknown {
	const parts = path.split(".");
	let current = root;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (current === null || current === undefined) return undefined;

		// Array projection: "files[]" \u2192 collect remaining path from each element
		if (part.endsWith("[]")) {
			// eslint-disable-next-line no-magic-numbers
			const key = part.slice(0, -2);
			const arr = getKey(current, key);
			if (!Array.isArray(arr)) return undefined;
			const rest = parts.slice(i + 1).join(".");
			if (!rest) return arr;
			return arr.map((item) => resolvePath(rest, item)).filter((v) => v !== undefined);
		}

		current = getKey(current, part);
	}

	return current;
}

/**
 *
 */
function getKey(obj: unknown, key: string): unknown {
	if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed to non-array object above
		return (obj as Record<string, unknown>)[key];
	}
	return undefined;
}
