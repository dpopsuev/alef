import { adapterComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createScribeOrgan } from "../src/adapter.js";

adapterComplianceSuite(() => createScribeOrgan());
