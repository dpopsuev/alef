import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createToolShellOrgan } from "../src/organ.js";

organComplianceSuite(() => createToolShellOrgan({ tools: [], getTools: () => [], organDirectives: new Map() }));
