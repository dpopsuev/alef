import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createGitAdapter } from "../src/adapter.js";

adapterComplianceSuite(() => createGitAdapter({ cwd: "/tmp" }));
