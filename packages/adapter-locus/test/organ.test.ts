import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createLocusOrgan } from "../src/adapter.js";

adapterComplianceSuite(() => createLocusOrgan());
