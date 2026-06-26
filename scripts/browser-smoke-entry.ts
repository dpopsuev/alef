import { getModel } from "@dpopsuev/alef-ai/models";
import { complete } from "@dpopsuev/alef-ai/stream";

const model = getModel("google", "gemini-2.5-flash");
console.log(model.id, typeof complete);
