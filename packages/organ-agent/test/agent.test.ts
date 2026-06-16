import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createAgentOrgan } from "../src/organ.js";

organComplianceSuite(() => createAgentOrgan({ cwd: "/tmp", replyEvent: "llm.response" }));
