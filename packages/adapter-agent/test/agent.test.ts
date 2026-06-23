import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createAgentOrgan } from "../src/adapter.js";

adapterComplianceSuite(() => createAgentOrgan({ cwd: "/tmp", replyEvent: "llm.response" }));
