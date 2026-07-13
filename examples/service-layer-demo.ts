/**
 * Live demonstration of ServiceLayerOrchestrator with multiple agents
 * 
 * Simulates N agents sharing N adapters with token conservation
 */

import { ServiceLayerOrchestrator } from "../packages/tools/service-layer/src/index.js";

// Mock adapter implementation
interface MockAdapterContext {
	payload: Record<string, unknown>;
	correlationId: string;
	log?: any;
}

function createMockAdapter(name: string, latencyMs: number = 100) {
	let executionCount = 0;
	
	const handlers = {
		motor: {
			[`${name}.read`]: {
				handle: async (ctx: MockAdapterContext) => {
					executionCount++;
					console.log(`  ⚡ ${name}.read executing (call #${executionCount})`);
					await new Promise(resolve => setTimeout(resolve, latencyMs));
					return {
						data: `Data from ${name}`,
						executionCount,
						timestamp: Date.now(),
						...ctx.payload,
					};
				},
			},
			[`${name}.search`]: {
				handle: async (ctx: MockAdapterContext) => {
					executionCount++;
					console.log(`  ⚡ ${name}.search executing (call #${executionCount})`);
					await new Promise(resolve => setTimeout(resolve, latencyMs));
					return {
						results: [`result1`, `result2`, `result3`],
						query: ctx.payload.query,
						executionCount,
					};
				},
			},
		},
		sense: {},
	};

	return {
		name,
		handlers,
		contributions: {},
		getExecutionCount: () => executionCount,
	} as any;
}

async function demonstrateServiceLayer() {
	console.log("\n🚀 Service Layer Orchestrator Demo\n");
	console.log("=" .repeat(60));
	
	// Initialize orchestrator
	const orchestrator = new ServiceLayerOrchestrator({
		maxCacheSizeMB: 50,
		cacheTTLMs: 300_000, // 5 minutes
		maxHistoryEntries: 5000,
		enableSemanticCache: true,
		similarityThreshold: 0.85,
		enableDeduplication: true,
		autoCleanup: true,
		cleanupIntervalMs: 30_000,
		enableMetrics: true,
	});

	// Register adapters
	console.log("\n📦 Registering adapters...");
	const fsAdapter = createMockAdapter("fs", 50);
	const dbAdapter = createMockAdapter("db", 100);
	const apiAdapter = createMockAdapter("api", 150);

	orchestrator.registerAdapter(fsAdapter);
	orchestrator.registerAdapter(dbAdapter);
	orchestrator.registerAdapter(apiAdapter);
	console.log("  ✓ Registered: fs, db, api");

	// Simulate 5 agents
	const agentCount = 5;
	console.log(`\n👥 Creating ${agentCount} agents...`);
	const agents = Array.from({ length: agentCount }, (_, i) => ({
		id: `agent-${i + 1}`,
		adapters: orchestrator.getAdaptersForAgent(`agent-${i + 1}`),
	}));
	console.log(`  ✓ Created ${agentCount} agents with proxied adapters`);

	// Scenario 1: Cache efficiency
	console.log("\n" + "=".repeat(60));
	console.log("📊 Scenario 1: Cache Efficiency Test");
	console.log("  Multiple agents reading the same file...\n");

	const readPromises = agents.map(async (agent, i) => {
		await new Promise(resolve => setTimeout(resolve, i * 10)); // Stagger requests
		console.log(`  🤖 ${agent.id}: Requesting fs.read`);
		return agent.adapters[0]?.handlers?.motor?.["fs.read"]?.handle({
			payload: { path: "shared-file.ts" },
			correlationId: `${agent.id}-read-1`,
		});
	});

	const results = await Promise.all(readPromises);
	console.log("\n  📈 Results:");
	console.log(`  - Total requests: ${agents.length}`);
	console.log(`  - Actual executions: ${(fsAdapter as any).getExecutionCount()}`);
	console.log(`  - Cache savings: ${agents.length - (fsAdapter as any).getExecutionCount()} requests`);
	
	// Scenario 2: Request deduplication
	console.log("\n" + "=".repeat(60));
	console.log("📊 Scenario 2: Request Deduplication");
	console.log("  All agents requesting simultaneously...\n");

	const concurrentReads = agents.map(agent => {
		console.log(`  🤖 ${agent.id}: Requesting db.read`);
		return agent.adapters[1]?.handlers?.motor?.["db.read"]?.handle({
			payload: { query: "SELECT * FROM users" },
			correlationId: `${agent.id}-db-1`,
		});
	});

	const dbResults = await Promise.all(concurrentReads);
	console.log("\n  📈 Results:");
	console.log(`  - Concurrent requests: ${agents.length}`);
	console.log(`  - Actual executions: ${(dbAdapter as any).getExecutionCount()}`);
	console.log(`  - Deduplication saved: ${agents.length - (dbAdapter as any).getExecutionCount()} executions`);

	// Scenario 3: Different requests (cache misses)
	console.log("\n" + "=".repeat(60));
	console.log("📊 Scenario 3: Unique Requests (Cache Misses)");
	console.log("  Each agent requesting different data...\n");

	const uniqueRequests = await Promise.all(
		agents.map(agent => {
			console.log(`  🤖 ${agent.id}: Requesting unique file`);
			return agent.adapters[0]?.handlers?.motor?.["fs.read"]?.handle({
				payload: { path: `${agent.id}-file.ts` },
				correlationId: `${agent.id}-unique`,
			});
		})
	);

	console.log("\n  📈 Results:");
	console.log(`  - Unique requests: ${agents.length}`);
	console.log(`  - All requests executed (no cache hits expected)`);

	// Get comprehensive metrics
	console.log("\n" + "=".repeat(60));
	console.log("📊 Overall Metrics\n");

	const metrics = orchestrator.getMetrics();
	console.log(`  Total Requests:     ${metrics.totalRequests}`);
	console.log(`  Cache Hits:         ${metrics.cacheHits}`);
	console.log(`  Cache Misses:       ${metrics.cacheMisses}`);
	console.log(`  Cache Hit Rate:     ${(metrics.cacheHitRate * 100).toFixed(1)}%`);
	console.log(`  Tokens Saved:       ~${metrics.tokensSaved.toLocaleString()}`);
	console.log(`  Avg Response Time:  ${metrics.avgResponseTimeMs.toFixed(1)}ms`);

	const stats = orchestrator.getStats();
	console.log(`\n  Cache Statistics:`);
	console.log(`  - Entries:          ${stats.cache.entries}`);
	console.log(`  - Size:             ${stats.cache.sizeMB.toFixed(2)} MB`);
	console.log(`  - Total Hits:       ${stats.cache.totalHits}`);
	console.log(`  - Avg Hits/Entry:   ${stats.cache.avgHitsPerEntry.toFixed(1)}`);

	console.log(`\n  Agent Distribution:`);
	Object.entries(stats.cache.agentDistribution).forEach(([agentId, count]) => {
		console.log(`  - ${agentId}: ${count} cache entries`);
	});

	console.log(`\n  Top Patterns:`);
	stats.patterns.topActions.slice(0, 5).forEach(action => {
		console.log(`  - ${action.adapter}.${action.action}: ${action.count} calls`);
	});

	// Scenario 4: Hot reload demonstration
	console.log("\n" + "=".repeat(60));
	console.log("📊 Scenario 4: Hot Reload (Blue-Green Deployment)\n");

	console.log("  🔄 Reloading 'api' adapter...");
	const newApiAdapter = createMockAdapter("api", 75); // Faster version
	await orchestrator.reloadAdapter("api", newApiAdapter);
	console.log("  ✓ Adapter reloaded, cache invalidated");

	// Agents get new proxies automatically
	console.log("\n  🤖 Testing with reloaded adapter...");
	const reloadedAdapters = orchestrator.getAdaptersForAgent("agent-1");
	await reloadedAdapters[2]?.handlers?.motor?.["api.read"]?.handle({
		payload: { endpoint: "/users" },
		correlationId: "reload-test",
	});
	console.log("  ✓ New adapter working correctly");

	// Export final state
	console.log("\n" + "=".repeat(60));
	console.log("💾 Final State Export\n");

	const state = orchestrator.exportState();
	console.log(JSON.stringify(state, null, 2));

	// Cleanup
	console.log("\n" + "=".repeat(60));
	console.log("🧹 Shutting down orchestrator...");
	orchestrator.shutdown();
	console.log("  ✓ Cleanup complete\n");
}

// Run demonstration
demonstrateServiceLayer().catch(console.error);
