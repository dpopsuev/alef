export type RestartPolicy = "permanent" | "transient" | "temporary";

export interface ManagedLifecycle {
	readonly name: string;
	start(): Promise<void>;
	stop(): Promise<void>;
	health(): Promise<boolean>;
	readonly restart: RestartPolicy;
}
