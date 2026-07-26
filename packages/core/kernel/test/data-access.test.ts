import { describe, expect, it, vi } from "vitest";
import {
	createRoleTenantDataAccessPolicy,
	DataAccessDeniedError,
	resolveAuthorizedData,
	type DataAccessRequest,
} from "../src/adapter/data-access.js";

const authorizedRequest: DataAccessRequest = {
	contractId: "meter.snapshot.v1",
	principal: { id: "user-1", tenantId: "tenant-1", roles: ["engineering"] },
	scope: { tenantId: "tenant-1", roles: ["product", "engineering"] },
};

describe("role and tenant data access policy", { tags: ["unit"] }, () => {
	it("resolves data only after an explicit tenant and role grant", () => {
		const resolve = vi.fn(() => ({ value: 42 }));

		const result = resolveAuthorizedData(createRoleTenantDataAccessPolicy(), authorizedRequest, resolve);

		expect(result).toEqual({ value: 42 });
		expect(resolve).toHaveBeenCalledOnce();
	});

	it.each([
		{
			name: "missing policy",
			policy: undefined,
			request: authorizedRequest,
		},
		{
			name: "different tenant",
			policy: createRoleTenantDataAccessPolicy(),
			request: { ...authorizedRequest, principal: { ...authorizedRequest.principal, tenantId: "tenant-2" } },
		},
		{
			name: "missing role",
			policy: createRoleTenantDataAccessPolicy(),
			request: { ...authorizedRequest, principal: { ...authorizedRequest.principal, roles: ["viewer"] } },
		},
		{
			name: "unscoped contract",
			policy: createRoleTenantDataAccessPolicy(),
			request: { ...authorizedRequest, scope: { ...authorizedRequest.scope, roles: [] } },
		},
	])("denies $name before resolving data", ({ policy, request }) => {
		const resolve = vi.fn(() => ({ value: 42 }));

		expect(() => resolveAuthorizedData(policy, request, resolve)).toThrow(DataAccessDeniedError);
		expect(resolve).not.toHaveBeenCalled();
	});
});
