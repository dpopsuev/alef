import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createFactoryAdapter } from "../src/adapter.js";

adapterComplianceSuite(() => createFactoryAdapter({ cwd: "/tmp" }));
