/** Identity used by a trusted host when requesting a governed data contract. */
export interface DataPrincipal {
	id: string;
	tenantId: string;
	roles: readonly string[];
}

/** Access requirements declared by the data-contract owner. */
export interface DataScope {
	tenantId: string;
	roles: readonly string[];
}

/** Request evaluated before a contract resolver can read data. */
export interface DataAccessRequest {
	contractId: string;
	principal: DataPrincipal;
	scope: DataScope;
}

/** Stable result for authorization decisions and audit records. */
export type DataAccessDecision =
	| { allowed: true; code: "allowed" }
	| {
			allowed: false;
			code: "policy-missing" | "scope-invalid" | "tenant-mismatch" | "role-missing";
	  };

/** Trusted policy port invoked before contract resolution. */
export interface DataAccessPolicy {
	check(request: DataAccessRequest): DataAccessDecision;
}

/** Expected denial from a governed contract read. */
export class DataAccessDeniedError extends Error {
	readonly code: Exclude<DataAccessDecision, { allowed: true }>["code"];

	constructor(contractId: string, code: Exclude<DataAccessDecision, { allowed: true }>["code"]) {
		super(`Data access denied for ${contractId}: ${code}`);
		this.name = "DataAccessDeniedError";
		this.code = code;
	}
}

/** Require the principal and contract to share a tenant and at least one role. */
export function createRoleTenantDataAccessPolicy(): DataAccessPolicy {
	return {
		check(request) {
			if (request.scope.tenantId.length === 0 || request.scope.roles.length === 0) {
				return { allowed: false, code: "scope-invalid" };
			}
			if (request.principal.tenantId !== request.scope.tenantId) {
				return { allowed: false, code: "tenant-mismatch" };
			}
			if (!request.principal.roles.some((role) => request.scope.roles.includes(role))) {
				return { allowed: false, code: "role-missing" };
			}
			return { allowed: true, code: "allowed" };
		},
	};
}

/** Evaluate access without touching the contract resolver. */
export function checkDataAccess(
	policy: DataAccessPolicy | undefined,
	request: DataAccessRequest,
): DataAccessDecision {
	return policy?.check(request) ?? { allowed: false, code: "policy-missing" };
}

/** Resolve contract data only after an explicit allow decision. */
export function resolveAuthorizedData<T>(
	policy: DataAccessPolicy | undefined,
	request: DataAccessRequest,
	resolveData: () => T,
): T {
	const decision = checkDataAccess(policy, request);
	if (!decision.allowed) throw new DataAccessDeniedError(request.contractId, decision.code);
	return resolveData();
}
