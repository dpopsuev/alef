import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createScribeOrgan } from "../src/adapter.js";

organComplianceSuite(() => createScribeOrgan());
