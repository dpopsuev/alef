import { organComplianceSuite } from "@dpopsuev/alef-testkit";
import { createDelegateOrgan } from "../src/organ.js";

organComplianceSuite(() => createDelegateOrgan({ strategies: {} }));
