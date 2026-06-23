import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createMcpRegistryOrgan } from "../src/adapter.js";

adapterComplianceSuite(() => createMcpRegistryOrgan({ cwd: "/tmp" }));
