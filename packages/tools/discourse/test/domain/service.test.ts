import { InMemoryDiscourseStore, InMemoryDiscourseSubscriptions } from "../../src/domain/memory-store.js";
import { DiscourseService } from "../../src/domain/service.js";
import { discourseConformanceSuite } from "./conformance.js";

let identifier = 0;
let timestamp = 1_000;
discourseConformanceSuite((options) => {
	const store = new InMemoryDiscourseStore({ eventRetention: options?.eventRetention });
	return {
		service: new DiscourseService({
			store,
			subscriptions: new InMemoryDiscourseSubscriptions(),
			createId: () => `post-${++identifier}`,
			now: () => ++timestamp,
		}),
	};
});
