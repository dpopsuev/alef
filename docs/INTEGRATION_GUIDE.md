# Service Layer Integration Guide

## Quick Start (5 minutes)

### 1. Install Package

```bash
cd packages/organ-service-layer
npm install
npm run build
```

### 2. Basic Setup

```typescript
import { ServiceLayerOrchestrator } from "@dpopsuev/organ-service-layer";
import { createFsOrgan } from "@dpopsuev/organ-fs";
import { createAgentOrgan } from "@dpopsuev/organ-agent";

// Create orchestrator
const orchestrator = new ServiceLayerOrchestrator({
  maxCacheSizeMB: 100,
  cacheTTLMs: 3600_000, // 1 hour
  maxHistoryEntries: 10_000,
  enableSemanticCache: true,
  similarityThreshold: 0.85,
  enableDeduplication: true,
  autoCleanup: true,
  cleanupIntervalMs: 60_000,
  enableMetrics: true,
});

// Register organs
orchestrator.registerOrgan(createFsOrgan({ cwd: process.cwd() }));
orchestrator.registerOrgan(createAgentOrgan({}));

// Get organs for each agent
const agent1Organs = orchestrator.getOrgansForAgent("agent-1");
const agent2Organs = orchestrator.getOrgansForAgent("agent-2");
```

## Integration Patterns

### Pattern 1: Retrofit Existing Agent System

**Before**:
```typescript
// Each agent has its own organ instances
const agent1 = createAgent({ organs: [fsOrgan(), dbOrgan()] });
const agent2 = createAgent({ organs: [fsOrgan(), dbOrgan()] });
// No sharing, duplicated work
```

**After**:
```typescript
// Shared organs via service layer
const orchestrator = new ServiceLayerOrchestrator(config);
orchestrator.registerOrgan(fsOrgan());
orchestrator.registerOrgan(dbOrgan());

const agent1 = createAgent({ organs: orchestrator.getOrgansForAgent("a1") });
const agent2 = createAgent({ organs: orchestrator.getOrgansForAgent("a2") });
// Automatic caching and deduplication!
```

### Pattern 2: Hot-Reload During Development

```typescript
// Initial organs
orchestrator.registerOrgan(createMyOrgan({ version: 1 }));

// Later, without restarting agents:
const newOrgan = createMyOrgan({ version: 2, newFeature: true });
await orchestrator.reloadOrgan("my-organ", newOrgan);

// All agents now use v2, cache cleared for this organ
```

### Pattern 3: Monitoring & Metrics

```typescript
// Periodic metrics export
setInterval(() => {
  const metrics = orchestrator.getMetrics();
  console.log(`Cache hit rate: ${(metrics.cacheHitRate * 100).toFixed(1)}%`);
  console.log(`Tokens saved: ${metrics.tokensSaved.toLocaleString()}`);
  
  const stats = orchestrator.getStats();
  console.log(`Active agents: ${stats.agents.active}`);
  console.log(`Cache size: ${stats.cache.sizeMB.toFixed(2)} MB`);
  
  // Send to monitoring system
  sendToDatadog(metrics);
  sendToPrometheus(stats);
}, 60_000);
```

### Pattern 4: Multi-Tenant Deployment

```typescript
// Each tenant gets isolated cache view
const tenantOrchestrators = new Map();

function getOrchestratorForTenant(tenantId: string) {
  if (!tenantOrchestrators.has(tenantId)) {
    const orch = new ServiceLayerOrchestrator(config);
    // Register tenant-specific organs
    registerOrgansForTenant(orch, tenantId);
    tenantOrchestrators.set(tenantId, orch);
  }
  return tenantOrchestrators.get(tenantId);
}

// Usage
const tenant1Orchestrator = getOrchestratorForTenant("tenant-1");
const agent = createAgent({ 
  organs: tenant1Orchestrator.getOrgansForAgent("agent-id")
});
```

## Configuration Guide

### Cache Configuration

```typescript
{
  maxCacheSizeMB: 100,          // Hard limit on cache memory
  cacheTTLMs: 3600_000,         // 1 hour expiration
  enableSemanticCache: true,    // Enable fuzzy matching
  similarityThreshold: 0.85,    // 85% similarity required
  enableDeduplication: true,    // Coalesce concurrent requests
}
```

**Tuning Tips**:
- **Low traffic**: `maxCacheSizeMB: 10-50`
- **High traffic**: `maxCacheSizeMB: 100-500`
- **FAQ bot**: `similarityThreshold: 0.80-0.85` (more fuzzy)
- **Critical ops**: `similarityThreshold: 0.95-0.99` (exact match)

### History Configuration

```typescript
{
  maxHistoryEntries: 10_000,    // Circular buffer size
  enableMetrics: true,          // Track patterns
}
```

**Tuning Tips**:
- **Development**: `maxHistoryEntries: 1_000`
- **Production**: `maxHistoryEntries: 10_000-100_000`
- **Analytics**: Enable metrics for pattern detection

### Cleanup Configuration

```typescript
{
  autoCleanup: true,            // Periodic cleanup
  cleanupIntervalMs: 60_000,    // Every minute
}
```

**Tuning Tips**:
- **Production**: `autoCleanup: true, cleanupIntervalMs: 60_000`
- **Development**: `autoCleanup: false` (manual cleanup)

## Advanced Integration

### Custom Cache Strategy

Extend `CacheService` for domain-specific caching:

```typescript
class CustomCacheService extends CacheService {
  async get(request: OrganRequest, strategy: CacheStrategy) {
    // Check custom cache tier first
    const custom = await this.checkCustomCache(request);
    if (custom) return custom;
    
    // Fall back to default
    return super.get(request, strategy);
  }
  
  private async checkCustomCache(request: OrganRequest) {
    // Domain-specific logic
    if (request.organName === "db" && request.action === "query") {
      return this.checkQueryPlanCache(request);
    }
    return undefined;
  }
}
```

### Distributed Caching with Redis

```typescript
import { createClient } from "redis";

class RedisCacheService extends CacheService {
  private redis = createClient({ url: "redis://localhost:6379" });
  
  async get(request: OrganRequest, strategy: CacheStrategy) {
    const key = this.generateKey(request);
    
    // Check Redis first
    const cached = await this.redis.get(`cache:${key}`);
    if (cached) {
      return JSON.parse(cached);
    }
    
    // Fall back to in-memory
    return super.get(request, strategy);
  }
  
  async set(request: OrganRequest, response: unknown) {
    const key = this.generateKey(request);
    
    // Store in both Redis and in-memory
    await this.redis.setex(
      `cache:${key}`, 
      this.config.cacheTTLMs / 1000, 
      JSON.stringify(response)
    );
    
    await super.set(request, response);
  }
}
```

### Event-Driven Architecture

Publish events for cache hits/misses:

```typescript
import { EventEmitter } from "events";

class EventDrivenOrchestrator extends ServiceLayerOrchestrator {
  private events = new EventEmitter();
  
  getOrganForAgent(organName: string, agentId: string) {
    const organ = super.getOrganForAgent(organName, agentId);
    
    // Wrap to emit events
    return this.wrapWithEvents(organ, agentId);
  }
  
  private wrapWithEvents(organ: Organ, agentId: string) {
    // Intercept and emit events
    const original = organ.handlers.motor;
    organ.handlers.motor = Object.fromEntries(
      Object.entries(original).map(([action, handler]) => [
        action,
        {
          ...handler,
          handle: async (ctx: any) => {
            this.events.emit("request", { organ: organ.name, action, agentId });
            const result = await handler.handle(ctx);
            this.events.emit("response", { organ: organ.name, action, agentId, cached: !!result.cached });
            return result;
          }
        }
      ])
    );
    return organ;
  }
  
  on(event: string, listener: (...args: any[]) => void) {
    this.events.on(event, listener);
  }
}

// Usage
orchestrator.on("response", ({ organ, action, agentId, cached }) => {
  console.log(`[${agentId}] ${organ}.${action} - ${cached ? "HIT" : "MISS"}`);
});
```

## Testing

### Unit Tests

```typescript
import { describe, it, expect } from "vitest";
import { ServiceLayerOrchestrator } from "./orchestrator";

describe("ServiceLayerOrchestrator", () => {
  it("should cache identical requests", async () => {
    const orchestrator = new ServiceLayerOrchestrator(config);
    // ... test implementation
  });
});
```

Run tests:
```bash
cd packages/organ-service-layer
npm test
```

### Load Testing

```typescript
// load-test.ts
import { performance } from "perf_hooks";

async function loadTest() {
  const orchestrator = new ServiceLayerOrchestrator(config);
  const agents = Array.from({ length: 100 }, (_, i) => `agent-${i}`);
  
  const start = performance.now();
  
  // 10,000 requests
  await Promise.all(
    agents.flatMap(agentId => 
      Array.from({ length: 100 }, (_, i) => 
        executeRequest(orchestrator, agentId, i)
      )
    )
  );
  
  const elapsed = performance.now() - start;
  const metrics = orchestrator.getMetrics();
  
  console.log(`
    Total requests: 10,000
    Elapsed: ${elapsed.toFixed(0)}ms
    Avg latency: ${(elapsed / 10000).toFixed(2)}ms
    Cache hit rate: ${(metrics.cacheHitRate * 100).toFixed(1)}%
    Tokens saved: ${metrics.tokensSaved.toLocaleString()}
  `);
}
```

## Deployment

### Production Checklist

- [ ] Set appropriate `maxCacheSizeMB` based on memory budget
- [ ] Enable `autoCleanup` with reasonable interval
- [ ] Configure metrics export (Datadog, Prometheus, etc.)
- [ ] Set up monitoring alerts for cache hit rate < 30%
- [ ] Implement health checks via `orchestrator.getStats()`
- [ ] Test hot-reload procedure
- [ ] Document cache invalidation strategy
- [ ] Set up distributed caching (Redis) for multi-instance

### Docker Deployment

```dockerfile
# Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN npm run build

ENV MAX_CACHE_SIZE_MB=100
ENV CACHE_TTL_MS=3600000
ENV SIMILARITY_THRESHOLD=0.85

CMD ["node", "dist/server.js"]
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: service-layer-orchestrator
spec:
  replicas: 3
  selector:
    matchLabels:
      app: orchestrator
  template:
    metadata:
      labels:
        app: orchestrator
    spec:
      containers:
      - name: orchestrator
        image: my-registry/orchestrator:latest
        env:
        - name: MAX_CACHE_SIZE_MB
          value: "100"
        - name: REDIS_URL
          value: "redis://redis-service:6379"
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
```

## Troubleshooting

### Low Cache Hit Rate

**Symptom**: `cacheHitRate < 0.3`

**Solutions**:
1. Lower `similarityThreshold` (0.85 → 0.80)
2. Increase `cacheTTLMs` (stale data acceptable?)
3. Check request diversity (too many unique requests?)
4. Verify canonical payload normalization

### High Memory Usage

**Symptom**: Cache size approaching limit

**Solutions**:
1. Decrease `maxCacheSizeMB`
2. Lower `cacheTTLMs` (faster eviction)
3. Check for large responses (implement size limits)
4. Enable more aggressive cleanup

### Slow Semantic Search

**Symptom**: High latency on cache lookups

**Solutions**:
1. Reduce cache size (fewer entries to search)
2. Switch to `strategy: "hash"` for critical paths
3. Implement embedding index (FAISS, Annoy)
4. Use distributed cache with vector DB

## Support

- **Documentation**: See `README.md` in package directory
- **Examples**: See `examples/service-layer-demo.ts`
- **Tests**: Run `npm test` in package directory
- **Issues**: File bugs in repository issue tracker

## Next Steps

1. **Run the demo**: `node examples/service-layer-demo.ts`
2. **Review metrics**: Analyze cache hit rates in your workload
3. **Tune thresholds**: Adjust similarity threshold based on results
4. **Integrate monitoring**: Export metrics to your observability platform
5. **Scale**: Add Redis for distributed caching
