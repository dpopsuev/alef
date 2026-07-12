import { getProviders } from "@dpopsuev/alef-ai/models";
import { getStoredApiKey, removeStoredApiKey, setStoredApiKey } from "../../boot/auth.js";
import type { AuthCmdCtx, Command } from "./types.js";

export const login: Command = {
	name: "login",
	description: "Save API key — :login <provider> <key>",
	run(ctx: AuthCmdCtx, args: string[]) {
		const [provider, ...rest] = args;
		const key = rest.join(" ").trim();
		if (!provider || !key) {
			const known = getProviders().slice(0, 8).join(", ");
			ctx.writer.addNotice(`Usage: :login <provider> <api-key>\nKnown providers: ${known}`);
		} else {
			void setStoredApiKey(provider, key);
			ctx.writer.addNotice(`Saved API key for ${provider}. Takes effect on the next message.`);
		}
		ctx.tui.requestRender();
	},
};

export const logout: Command = {
	name: "logout",
	description: "Remove stored API key — :logout <provider>",
	run(ctx: AuthCmdCtx, args: string[]) {
		const [provider] = args;
		if (!provider) {
			ctx.writer.addNotice("Usage: :logout <provider>");
		} else if (!getStoredApiKey(provider)) {
			ctx.writer.addNotice(`No stored key for ${provider}.`);
		} else {
			void removeStoredApiKey(provider);
			ctx.writer.addNotice(`Removed stored key for ${provider}.`);
		}
		ctx.tui.requestRender();
	},
};
