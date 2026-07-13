import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/adapter";
import { createLocusAdapter } from "../src/adapter.js";

adapterComplianceSuite(() => createLocusAdapter());
