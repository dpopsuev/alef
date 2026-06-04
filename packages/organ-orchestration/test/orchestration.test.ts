import { organComplianceSuite } from "@dpopsuev/alef-testkit";
import { createOrchestrationOrgan } from "../src/organ.js";

organComplianceSuite(() => createOrchestrationOrgan({ cwd: "/tmp" }));
