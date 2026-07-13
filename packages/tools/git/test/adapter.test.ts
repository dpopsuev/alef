import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/adapter";
import { createGitAdapter } from "../src/adapter.js";

adapterComplianceSuite(() => createGitAdapter({ cwd: "/tmp" }));
