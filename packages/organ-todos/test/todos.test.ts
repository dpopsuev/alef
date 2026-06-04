import { organComplianceSuite } from "@dpopsuev/alef-testkit";
import { createTodosOrgan } from "../src/organ.js";

organComplianceSuite(() => createTodosOrgan());
