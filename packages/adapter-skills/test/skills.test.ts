import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createSkillsAdapter } from "../src/adapter.js";

adapterComplianceSuite(() => createSkillsAdapter({ cwd: "/tmp" }));
