import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createLocusAdapter } from "../src/adapter.js";

adapterComplianceSuite(() => createLocusAdapter());
