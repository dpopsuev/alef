import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createCompactorOrgan } from "../src/organ.js";

organComplianceSuite(() => createCompactorOrgan({ cwd: "/tmp" }));
