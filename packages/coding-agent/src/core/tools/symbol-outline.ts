import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { extname } from "node:path";
import type { AgentTool } from "@dpopsuev/alef-agent-core";
import { Text } from "@dpopsuev/alef-tui";
import { type Static, Type } from "typebox";
import ts from "typescript";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import type { LectorRuntime } from "../lector-runtime.js";
import { resolveReadPath } from "./path-utils.js";
import { invalidArgText, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const symbolOutlineSchema = Type.Object({
	path: Type.String({ description: "Path to a source file (relative or absolute)" }),
	memberDepth: Type.Optional(
		Type.Number({
			description: "How deep to expand class members and nested named functions (0 = top-level only, default 2)",
		}),
	),
});

export type SymbolOutlineToolInput = Static<typeof symbolOutlineSchema>;

export interface SymbolOutlineToolDetails {
	truncated?: boolean;
	maxLines?: number;
}

const MAX_OUTPUT_LINES = 400;

const TS_JS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

/** Optional injected filesystem operations for remote backends */
export interface SymbolOutlineOperations {
	readFile: (absolutePath: string) => Promise<string>;
	access: (absolutePath: string) => Promise<void>;
}

const defaultSymbolOutlineOperations: SymbolOutlineOperations = {
	readFile: (p) => fsReadFile(p, "utf-8"),
	access: (p) => fsAccess(p, constants.R_OK),
};

export interface SymbolOutlineToolOptions {
	operations?: SymbolOutlineOperations;
	runtime?: LectorRuntime;
}

function getScriptKind(filePath: string): ts.ScriptKind {
	switch (extname(filePath).toLowerCase()) {
		case ".tsx":
			return ts.ScriptKind.TSX;
		case ".jsx":
			return ts.ScriptKind.JSX;
		case ".ts":
		case ".mts":
		case ".cts":
			return ts.ScriptKind.TS;
		default:
			return ts.ScriptKind.JS;
	}
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
	return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function formatClassLikeBody(
	sf: ts.SourceFile,
	body: ts.ClassLikeDeclaration,
	memberDepth: number,
	indent: string,
): string[] {
	if (memberDepth <= 0) return [];
	const lines: string[] = [];
	for (const member of body.members) {
		if (ts.isConstructorDeclaration(member)) {
			lines.push(`${indent}- constructor (${lineOf(sf, member)})`);
		} else if (ts.isMethodDeclaration(member) && member.name) {
			const name = member.name.getText(sf);
			lines.push(`${indent}- method ${name} (${lineOf(sf, member)})`);
		} else if (ts.isPropertyDeclaration(member) && member.name) {
			const name = member.name.getText(sf);
			lines.push(`${indent}- property ${name} (${lineOf(sf, member)})`);
		} else if (ts.isGetAccessorDeclaration(member) && member.name) {
			lines.push(`${indent}- get ${member.name.getText(sf)} (${lineOf(sf, member)})`);
		} else if (ts.isSetAccessorDeclaration(member) && member.name) {
			lines.push(`${indent}- set ${member.name.getText(sf)} (${lineOf(sf, member)})`);
		}
	}
	return lines;
}

function collectInnerNamedFunctions(
	sf: ts.SourceFile,
	body: ts.Block | ts.FunctionBody,
	depth: number,
	indent: string,
): string[] {
	if (depth <= 0) return [];
	const lines: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) && node.name) {
			lines.push(`${indent}- nested function ${node.name.text} (${lineOf(sf, node)})`);
		}
		ts.forEachChild(node, visit);
	};
	visit(body);
	return lines;
}

function collectFromSource(sf: ts.SourceFile, displayPath: string, memberDepth: number): string {
	const imports: string[] = [];
	const declarations: string[] = [];

	const pushDecl = (kind: string, name: string, node: ts.Node, extra?: string[]): void => {
		const line = lineOf(sf, node);
		const block = [`- ${kind} ${name} (${line})`];
		if (extra && extra.length > 0) block.push(...extra);
		declarations.push(...block);
	};

	for (const stmt of sf.statements) {
		if (ts.isImportDeclaration(stmt)) {
			const mod =
				stmt.moduleSpecifier && ts.isStringLiteralLike(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : "?";
			const names: string[] = [];
			const clause = stmt.importClause;
			if (clause) {
				if (clause.name) names.push(`default:${clause.name.text}`);
				if (clause.namedBindings) {
					if (ts.isNamespaceImport(clause.namedBindings)) {
						names.push(`* as ${clause.namedBindings.name.text}`);
					} else if (ts.isNamedImports(clause.namedBindings)) {
						for (const el of clause.namedBindings.elements) {
							const part = el.propertyName ? `${el.propertyName.text} as ${el.name.text}` : el.name.text;
							names.push(part);
						}
					}
				}
			}
			imports.push(`- "${mod}" (${lineOf(sf, stmt)}): ${names.join(", ") || "(side-effect)"}`);
			continue;
		}

		if (ts.isExportDeclaration(stmt)) {
			const mod =
				stmt.moduleSpecifier && ts.isStringLiteralLike(stmt.moduleSpecifier)
					? stmt.moduleSpecifier.text
					: undefined;
			if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
				const names = stmt.exportClause.elements.map((e) => e.name.text).join(", ");
				pushDecl("export", `{ ${names} }${mod ? ` from "${mod}"` : ""}`, stmt);
			} else if (mod) {
				pushDecl("export", `* from "${mod}"`, stmt);
			}
			continue;
		}

		if (ts.isFunctionDeclaration(stmt) && stmt.name) {
			const extras =
				stmt.body && memberDepth > 0 ? collectInnerNamedFunctions(sf, stmt.body, memberDepth - 1, "  ") : [];
			pushDecl("function", stmt.name.text, stmt, extras);
			continue;
		}

		if (ts.isClassDeclaration(stmt) && stmt.name) {
			const members = formatClassLikeBody(sf, stmt, memberDepth, "  ");
			pushDecl("class", stmt.name.text, stmt, members);
			continue;
		}

		if (ts.isInterfaceDeclaration(stmt)) {
			pushDecl("interface", stmt.name.text, stmt);
			continue;
		}

		if (ts.isTypeAliasDeclaration(stmt)) {
			pushDecl("type", stmt.name.text, stmt);
			continue;
		}

		if (ts.isEnumDeclaration(stmt)) {
			const members = stmt.members.map((m) => m.name.getText(sf)).join(", ");
			pushDecl("enum", `${stmt.name.text} { ${members} }`, stmt);
			continue;
		}

		if (ts.isModuleDeclaration(stmt) && stmt.name && ts.isIdentifier(stmt.name)) {
			pushDecl("namespace/module", stmt.name.text, stmt);
			continue;
		}

		if (ts.isVariableStatement(stmt)) {
			for (const decl of stmt.declarationList.declarations) {
				if (!decl.name || !ts.isIdentifier(decl.name)) continue;
				const id = decl.name.text;
				if (decl.initializer) {
					if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
						const b = decl.initializer.body;
						const extras =
							memberDepth > 0 && ts.isBlock(b) ? collectInnerNamedFunctions(sf, b, memberDepth - 1, "  ") : [];
						pushDecl("const fn", id, decl, extras);
					} else if (ts.isClassExpression(decl.initializer)) {
						const members = formatClassLikeBody(sf, decl.initializer, memberDepth, "  ");
						pushDecl("const class", id, decl, members);
					} else {
						pushDecl("variable", id, decl);
					}
				} else {
					pushDecl("variable", id, decl);
				}
			}
			continue;
		}

		if (ts.isExportAssignment(stmt)) {
			const txt = stmt.expression.getText(sf);
			pushDecl("export default", txt, stmt);
		}
	}

	const head = `# Structural view\nFile: ${displayPath}\n`;
	const impSection = imports.length > 0 ? `## Imports\n${imports.join("\n")}\n\n` : "";
	const declSection =
		declarations.length > 0
			? `## Declarations\n${declarations.join("\n")}\n`
			: "## Declarations\n(no declarations matched)\n";
	return head + impSection + declSection;
}

function truncateLines(text: string, maxLines: number): { text: string; truncated: boolean } {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return { text, truncated: false };
	return {
		text: `${lines.slice(0, maxLines).join("\n")}\n\n[Truncated: ${lines.length - maxLines} more lines; narrow scope or use file_read for full source]`,
		truncated: true,
	};
}

function formatSymbolOutlineCall(
	args: { path?: string; memberDepth?: number } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath) : null;
	const invalidArg = invalidArgText(theme);
	const pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
	const depth = args?.memberDepth !== undefined ? theme.fg("toolOutput", ` depth=${args.memberDepth}`) : "";
	return `${theme.fg("toolTitle", theme.bold("symbol_outline"))} ${pathDisplay}${depth}`;
}

function formatSymbolOutlineResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: SymbolOutlineToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	void options;
	void showImages;
	let text = "";
	for (const c of result.content) {
		if (c.type === "text" && c.text) text += c.text;
	}
	const details = result.details;
	if (details?.truncated) {
		text += `\n${theme.fg("warning", `[Output truncated to ${details.maxLines ?? MAX_OUTPUT_LINES} lines]`)}`;
	}
	return text.trim();
}

export function createSymbolOutlineToolDefinition(
	cwd: string,
	options?: SymbolOutlineToolOptions,
): ToolDefinition<typeof symbolOutlineSchema, SymbolOutlineToolDetails | undefined> {
	const ops = options?.operations ?? defaultSymbolOutlineOperations;
	return {
		name: "symbol_outline",
		label: "symbol_outline",
		description:
			"Symbol family (`symbol_*`): structural outline of one source file — imports, exports, declarations, class members (TypeScript compiler API today; LSP/tree-sitter-backed symbol tools to follow). Prefer over `file_read` when mapping structure. Unsupported extensions return an error until tree-sitter adds that language.",
		promptSnippet: "Outline imports and declarations in a TS/JS file (symbol tools, not raw file bytes)",
		promptGuidelines: [
			"For .ts, .tsx, .js, .jsx and related extensions, prefer symbol_outline over file_read when discovering structure",
			"Treat modules as import/export boundaries plus named declarations; use file_* tools for bytes and shell",
		],
		parameters: symbolOutlineSchema,
		async execute(_toolCallId, params: SymbolOutlineToolInput, _signal) {
			const memberDepth = params.memberDepth !== undefined ? Math.max(0, Math.floor(params.memberDepth)) : 2;
			const resolved = resolveReadPath(params.path, cwd);
			await ops.access(resolved);
			const ext = extname(resolved).toLowerCase();
			if (!TS_JS_EXTS.has(ext)) {
				return {
					content: [
						{
							type: "text",
							text: `symbol_outline: unsupported extension ${ext}. Supported: ${[...TS_JS_EXTS].join(", ")}.`,
						},
					],
					details: undefined,
				};
			}
			const text = await ops.readFile(resolved);
			const sf = ts.createSourceFile(resolved, text, ts.ScriptTarget.Latest, true, getScriptKind(resolved));
			const displayPath = params.path;
			const body = collectFromSource(sf, displayPath, memberDepth);
			const { text: out, truncated } = truncateLines(body, MAX_OUTPUT_LINES);
			const details: SymbolOutlineToolDetails | undefined = truncated
				? { truncated: true, maxLines: MAX_OUTPUT_LINES }
				: undefined;
			return {
				content: [{ type: "text", text: out }],
				details,
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSymbolOutlineCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSymbolOutlineResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createSymbolOutlineTool(
	cwd: string,
	options?: SymbolOutlineToolOptions,
): AgentTool<typeof symbolOutlineSchema> {
	return wrapToolDefinition(createSymbolOutlineToolDefinition(cwd, options));
}
