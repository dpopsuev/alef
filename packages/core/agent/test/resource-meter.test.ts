import { describe, expect, it } from "vitest";
import { createRoleTenantDataAccessPolicy } from "@dpopsuev/alef-kernel/adapter";
import { InProcessBus } from "@dpopsuev/alef-kernel/bus";
import {
	createResourceMeter,
	METER_SNAPSHOT_CONTRACT_ID,
	METER_SNAPSHOT_SCHEMA,
} from "../src/resource-meter.js";

const access = {
	policy: createRoleTenantDataAccessPolicy(),
	principal: { id: "operator-1", tenantId: "session-1", roles: ["operator"] },
	scope: { tenantId: "session-1", roles: ["operator"] },
};

describe("resource meter contract", { tags: ["unit"] }, () => {
	it("publishes a versioned snapshot after authorized resource observations", () => {
		const bus = new InProcessBus().asBus();
		const snapshots: unknown[] = [];
		bus.notification.subscribe("meter.snapshot", (event) => {
			snapshots.push(event.payload);
		});
		const meter = createResourceMeter(access);
		expect(meter.publishSchemas?.notification?.["meter.snapshot"]).toBe(METER_SNAPSHOT_SCHEMA);
		const dispose = meter.mount(bus);

		bus.notification.publish({
			type: "llm.token-usage",
			correlationId: "turn-1",
			payload: { usage: { input: 120, output: 30, cacheRead: 80 } },
		});
		bus.event.publish({
			type: "tool.completed",
			correlationId: "turn-1",
			isError: false,
			payload: { name: "fs.read", elapsedMs: 40, ok: true },
		});

		expect(snapshots).toHaveLength(2);
		const snapshot = METER_SNAPSHOT_SCHEMA.parse(snapshots.at(-1));
		expect(snapshot.contractId).toBe(METER_SNAPSHOT_CONTRACT_ID);
		expect(snapshot.session).toMatchObject({ turns: 1, tokensIn: 120, tokensOut: 30, tokensTotal: 150 });
		expect(snapshot.tools).toMatchObject({ totalCalls: 1, totalErrors: 0, errorRatePercent: 0, p95Ms: 40 });
		expect(snapshot.topTools[0]).toMatchObject({ name: "fs.read", calls: 1, successRatePercent: 100 });

		dispose();
	});

	it("fails closed without a matching tenant grant", () => {
		const bus = new InProcessBus().asBus();
		const snapshots: unknown[] = [];
		bus.notification.subscribe("meter.snapshot", (event) => {
			snapshots.push(event.payload);
		});
		const meter = createResourceMeter({
			...access,
			principal: { ...access.principal, tenantId: "other-session" },
		});
		const dispose = meter.mount(bus);

		bus.notification.publish({
			type: "llm.token-usage",
			correlationId: "turn-1",
			payload: { usage: { input: 120, output: 30, cacheRead: 80 } },
		});

		expect(snapshots).toEqual([]);
		dispose();
	});

	it("rejects an unversioned snapshot at the contract boundary", () => {
		expect(METER_SNAPSHOT_SCHEMA.safeParse({ session: {}, tools: {}, topTools: [] }).success).toBe(false);
	});
});
