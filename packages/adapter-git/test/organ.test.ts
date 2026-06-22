import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createGitOrgan } from "../src/organ.js";

organComplianceSuite(() => createGitOrgan({ cwd: "/tmp" }));
