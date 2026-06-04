import { organComplianceSuite } from "@dpopsuev/alef-testkit";
import { createSkillsOrgan } from "../src/organ.js";

organComplianceSuite(() => createSkillsOrgan({ cwd: "/tmp" }));
