import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createScribeAdapter } from "../src/adapter.js";

adapterComplianceSuite(() => createScribeAdapter());
