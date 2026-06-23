import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createGitOrgan } from "../src/adapter.js";

adapterComplianceSuite(() => createGitOrgan({ cwd: "/tmp" }));
