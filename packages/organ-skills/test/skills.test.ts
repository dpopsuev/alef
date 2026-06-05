import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createSkillsOrgan } from "../src/organ.js";

organComplianceSuite(() => createSkillsOrgan({ cwd: "/tmp" }));
