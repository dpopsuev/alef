/**
 * OTel setup for the Alef runner — re-exports shared agent bootstrap.
 */
export {
	activateInheritedTraceContext,
	injectTraceContextIntoEnv,
	runWithInheritedTrace,
	setupOTel,
	shouldEnableOTelForAgent,
	shutdownOTel,
	upgradeToSqliteExporter,
} from "@dpopsuev/alef-agent/otel-setup";
