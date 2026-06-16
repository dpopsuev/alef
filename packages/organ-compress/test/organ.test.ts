import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createCompressOrgan } from "../src/organ.js";

organComplianceSuite(() => createCompressOrgan({ cwd: "/tmp" }));
