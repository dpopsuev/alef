import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createGitOrgan } from "../src/adapter.js";

organComplianceSuite(() => createGitOrgan({ cwd: "/tmp" }));
