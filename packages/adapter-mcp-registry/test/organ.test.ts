import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createMcpRegistryOrgan } from "../src/adapter.js";

organComplianceSuite(() => createMcpRegistryOrgan({ cwd: "/tmp" }));
