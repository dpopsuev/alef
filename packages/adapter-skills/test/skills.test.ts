import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createSkillsOrgan } from "../src/adapter.js";

adapterComplianceSuite(() => createSkillsOrgan({ cwd: "/tmp" }));
