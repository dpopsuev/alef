import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/adapter";
import { createAgentAdapter } from "../src/adapter.js";

adapterComplianceSuite(() => createAgentAdapter({ cwd: "/tmp", replyEvent: "llm.response" }));
