import type { ColorToken } from "./tui/ansi.js";
export type { ColorDepth, ColorToken } from "./tui/ansi.js";

export interface ThemeTokens {
	userFg: ColorToken;
	userBg: ColorToken;
	agentBg: ColorToken;
	agentFg: ColorToken;
	toolNameFg: ColorToken;
	toolArgFg: ColorToken;
	toolOkFg: ColorToken;
	toolErrFg: ColorToken;
	accentFg: ColorToken;
	dimFg: ColorToken;
	okFg: ColorToken;
	warnFg: ColorToken;
	errFg: ColorToken;
	timeFg: ColorToken;
	modelFg: ColorToken;
}
