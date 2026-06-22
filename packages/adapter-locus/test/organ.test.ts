import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createLocusOrgan } from "../src/organ.js";

organComplianceSuite(() => createLocusOrgan());
