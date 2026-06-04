import { organComplianceSuite } from "@dpopsuev/alef-testkit";
import { createHitlOrgan } from "../src/organ.js";

organComplianceSuite(() => createHitlOrgan({ onEvaluate: async () => ({ approved: true }) }));
