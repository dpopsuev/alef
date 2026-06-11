import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createOrchestrationOrgan } from "../src/organ.js";

organComplianceSuite(() => createOrchestrationOrgan({ cwd: "/tmp", replyEvent: "llm.response" }));
