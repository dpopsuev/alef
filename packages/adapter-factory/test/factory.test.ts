import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createFactoryOrgan } from "../src/adapter.js";

organComplianceSuite(() => createFactoryOrgan({ cwd: "/tmp" }));
