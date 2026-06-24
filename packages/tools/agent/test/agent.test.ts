import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createAgentAdapter } from "../src/adapter.js";

adapterComplianceSuite(() => createAgentAdapter({ cwd: "/tmp", replyEvent: "llm.response" }));
