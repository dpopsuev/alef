import { organComplianceSuite } from "@dpopsuev/alef-testkit/organ";
import { createTodosOrgan } from "../src/organ.js";

organComplianceSuite(() => createTodosOrgan());
