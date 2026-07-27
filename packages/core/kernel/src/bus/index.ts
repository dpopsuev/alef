export type {
	AgentBus,
	Bus,
	BusChannel,
	BusMessage,
	BusMiddleware,
	BusView,
	ChannelHandler,
	ChannelInput,
	ChannelMap,
	ChannelMessages,
	ChannelName,
	CommandHandler,
	CommandInput,
	CommandMessage,
	EventHandler,
	EventInput,
	EventMessage,
	NotificationHandler,
	NotificationInput,
	NotificationMessage,
} from "./messages.js";
export { CHANNEL, makeBus, newCorrelationId } from "./messages.js";
export {
	buildErrorResult,
	buildEventResult,
	extractToolCallId,
} from "./event-builders.js";
export { withAutoTrace } from "./auto-trace.js";
export { canonicalChannel, checkChannelViolation } from "./channel-registry.js";
export { InProcessBus, type BusOptions, type WatchdogOptions } from "./in-process-bus.js";
export { Watchdog } from "./watchdog.js";
