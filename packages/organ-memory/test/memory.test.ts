import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createMemoryOrgan } from "../src/organ.js";

organComplianceSuite(() => createMemoryOrgan());
