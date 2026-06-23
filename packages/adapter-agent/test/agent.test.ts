import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createAgentOrgan } from "../src/adapter.js";

organComplianceSuite(() => createAgentOrgan({ cwd: "/tmp", replyEvent: "llm.response" }));
