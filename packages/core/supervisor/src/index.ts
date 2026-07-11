// Re-export lifecycle types
export type {
	RestartPolicy,
	ManagedLifecycle,
	ServiceRegistry,
	ServiceCreateOpts,
	ServiceDescriptor,
	ManagedService,
} from './lifecycle.js';

// Export supervisor
export { Supervisor, isServiceDescriptor, createServiceResolver } from './supervisor.js';
export type { ServiceResolverOpts } from './supervisor.js';

// Export new modules
export { detectEnvironment } from './environment.js';
export type { RuntimeEnvironment } from './environment.js';
export { createHotReloadDescriptor } from './hot-reload.js';
