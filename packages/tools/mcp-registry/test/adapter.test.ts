import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/adapter";
import { createMcpRegistryAdapter } from "../src/adapter.js";

adapterComplianceSuite(() => createMcpRegistryAdapter({ cwd: "/tmp" }));
