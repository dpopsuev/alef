import { getModel } from "@dpopsuev/alef-ai/models";
import { complete } from "@dpopsuev/alef-ai/stream";
import { composeResourceTile, TileDesk } from "../packages/ui/web/src/index.js";

const model = getModel("google", "gemini-2.5-flash");
const tile = composeResourceTile("engineering");
console.log(model.id, typeof complete, tile.contractId, typeof TileDesk);
