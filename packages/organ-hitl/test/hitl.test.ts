import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createHitlOrgan } from "../src/organ.js";

organComplianceSuite(() => createHitlOrgan({ onEvaluate: async () => ({ approved: true }) }));
