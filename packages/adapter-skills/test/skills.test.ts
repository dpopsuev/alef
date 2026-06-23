import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createSkillsOrgan } from "../src/adapter.js";

organComplianceSuite(() => createSkillsOrgan({ cwd: "/tmp" }));
