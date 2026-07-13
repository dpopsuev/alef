import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/adapter";
import { createSkillsAdapter } from "../src/adapter.js";

adapterComplianceSuite(() => createSkillsAdapter({ cwd: "/tmp" }));
