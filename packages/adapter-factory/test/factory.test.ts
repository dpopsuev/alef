import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createFactoryOrgan } from "../src/adapter.js";

adapterComplianceSuite(() => createFactoryOrgan({ cwd: "/tmp" }));
