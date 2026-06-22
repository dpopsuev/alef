import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createFactoryOrgan } from "../src/organ.js";

organComplianceSuite(() => createFactoryOrgan({ cwd: "/tmp" }));
