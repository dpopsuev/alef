import { organComplianceSuite } from "@dpopsuev/alef-testkit";
import { createMemoryOrgan } from "../src/organ.js";

organComplianceSuite(() => createMemoryOrgan());
