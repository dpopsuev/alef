import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/adapter";
import { createScribeAdapter } from "../src/adapter.js";

adapterComplianceSuite(() => createScribeAdapter());
