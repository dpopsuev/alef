import { materializeBlueprint as materializeCompiledBlueprint, type AdapterFactoryOptions } from "@dpopsuev/alef-blueprint/materializer";
import type { CompiledAgentDefinition } from "@dpopsuev/alef-blueprint/types";
import { Supervisor, isServiceDescriptor } from "@dpopsuev/alef-supervisor/supervisor";
import type { MaterializerOptions, MaterializerResult } from "@dpopsuev/alef-blueprint/materializer";
import type { ServiceCreateOpts, ServiceDescriptor } from "@dpopsuev/alef-supervisor/lifecycle";
import type { FoundryMaterializeOptions, FoundryRuntime, FoundryRuntimeOptions, FoundryStartOptions } from "./types.js";

/** Merge runtime defaults with per-call service startup overrides. */
function toServiceCreateOpts(base: FoundryRuntimeOptions, overrides?: FoundryStartOptions): ServiceCreateOpts {
	return {
		cwd: overrides?.cwd ?? base.cwd,
		bus: overrides?.bus ?? base.bus,
		logger: overrides?.logger ?? base.logger,
		actorAddress: overrides?.actorAddress ?? base.actorAddress,
		discussion: overrides?.discussion ?? base.discussion,
		sessionId: overrides?.sessionId ?? base.sessionId,
	};
}

/** Merge runtime defaults with per-call blueprint materialization overrides. */
function toMaterializerOptions(
	base: FoundryRuntimeOptions,
	resolveService: FoundryRuntime["resolveService"],
	overrides?: FoundryMaterializeOptions,
): MaterializerOptions {
	return {
		cwd: overrides?.cwd ?? base.cwd,
		loggerFor: overrides?.loggerFor ?? base.loggerFor,
		allowedTools: overrides?.allowedTools ?? base.allowedTools,
		resolveExternalPath: overrides?.resolveExternalPath ?? base.resolveExternalPath,
		writableRoots: overrides?.writableRoots ?? base.writableRoots,
		sessionDir: overrides?.sessionDir ?? base.sessionDir,
		actorAddress: overrides?.actorAddress ?? base.actorAddress,
		discussion: overrides?.discussion ?? base.discussion,
		sessionId: overrides?.sessionId ?? base.sessionId ?? overrides?.discussion?.topicId ?? base.discussion?.topicId,
		resolveService,
	};
}

/** Compose supervisor-backed service resolution with blueprint materialization. */
export function createFoundryRuntime(options: FoundryRuntimeOptions): FoundryRuntime {
	const supervisor = new Supervisor();

	const resolveService: FoundryRuntime["resolveService"] = async (service, opts: AdapterFactoryOptions) => {
		if (!isServiceDescriptor(service)) return undefined;
		const managed = await supervisor.getOrStart(service, {
			cwd: opts.cwd,
			logger: opts.logger ?? options.logger,
			actorAddress: opts.actorAddress ?? options.actorAddress,
			discussion: opts.discussion ?? options.discussion,
			sessionId: opts.sessionId ?? options.sessionId ?? opts.discussion?.topicId ?? options.discussion?.topicId,
		});
		return managed.adapters;
	};

	return {
		supervisor,
		register(descriptor: ServiceDescriptor) {
			supervisor.register(descriptor);
		},
		get(name: string) {
			return supervisor.get(name);
		},
		names() {
			return supervisor.names();
		},
		async ensure(descriptor: ServiceDescriptor, opts?: FoundryStartOptions) {
			return await supervisor.getOrStart(descriptor, toServiceCreateOpts(options, opts));
		},
		async stopService(name: string) {
			await supervisor.stop(name);
		},
		adapters() {
			return supervisor.adapters();
		},
		tools() {
			return supervisor.tools();
		},
		async start(opts?: FoundryStartOptions) {
			await supervisor.startAll(toServiceCreateOpts(options, opts));
		},
		async swap(name: string, opts?: FoundryStartOptions) {
			await supervisor.swap(name, toServiceCreateOpts(options, opts));
		},
		async stop() {
			await supervisor.stopAll();
		},
		resolveService,
		async materializeBlueprint(
			definition: CompiledAgentDefinition,
			opts?: FoundryMaterializeOptions,
		): Promise<MaterializerResult> {
			return await materializeCompiledBlueprint(definition, toMaterializerOptions(options, resolveService, opts));
		},
	};
}
