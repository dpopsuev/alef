import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/adapter";
import { createFactoryAdapter } from "../src/adapter.js";

adapterComplianceSuite(() => createFactoryAdapter({ cwd: "/tmp" }));
