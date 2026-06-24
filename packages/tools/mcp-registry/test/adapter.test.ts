import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createMcpRegistryAdapter } from "../src/adapter.js";

adapterComplianceSuite(() => createMcpRegistryAdapter({ cwd: "/tmp" }));
