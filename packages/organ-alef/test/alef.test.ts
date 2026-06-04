import { organComplianceSuite } from "@dpopsuev/alef-testkit";
import { createAlefApiOrgan } from "../src/organ.js";

organComplianceSuite(() => createAlefApiOrgan());
