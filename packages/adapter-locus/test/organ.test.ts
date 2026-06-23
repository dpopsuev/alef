import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createLocusOrgan } from "../src/adapter.js";

organComplianceSuite(() => createLocusOrgan());
