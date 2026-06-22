import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createMcpRegistryOrgan } from "../src/organ.js";

organComplianceSuite(() => createMcpRegistryOrgan({ cwd: "/tmp" }));
