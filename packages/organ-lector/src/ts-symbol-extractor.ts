/**
 * TypeScript compiler API symbol extractor — Lector v2 Phase 1.
 *
 * Replaces the regex-based extractor for .ts and .tsx files.
 * Uses ts.createSourceFile() for exact AST-level extraction:
 *   - Accurate line numbers (start and end)
 *   - Correct handling of generics, decorators, abstract classes
 *   - Arrow function const detection
 *   - Class method extraction
 *   - No false positives from comment-embedded declarations
 *
 * Handles:
 *   export function / async function
 *   export class / abstract class
 *   export interface
 *   export type
 *   export const / let / var (including arrow functions)
 *   class methods and property declarations
 *
 * Falls back to the regex extractor for non-TS files.
 */

import ts from "typescript";
import type { SymbolBlock, SymbolKind } from "./backend.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasExportModifier(node: ts.Node): boolean {
	return (ts.getModifiers(node as ts.HasModifiers) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function lineOf(source: ts.SourceFile, pos: number): number {
	return source.getLineAndCharacterOfPosition(pos).line + 1; // 1-indexed
}

function endLineOf(source: ts.SourceFile, node: ts.Node): number {
	return lineOf(source, node.getEnd());
}

// ---------------------------------------------------------------------------
// Main extractor
// ---------------------------------------------------------------------------

export function extractSymbolsTs(content: string, fileName = "file.ts"): SymbolBlock[] {
	const source = ts.createSourceFile(
		fileName,
		content,
		ts.ScriptTarget.Latest,
		/* setParentNodes */ true,
		fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);

	const symbols: SymbolBlock[] = [];

	function visit(node: ts.Node): void {
		// export function / async function
		if (ts.isFunctionDeclaration(node) && node.name) {
			symbols.push({
				name: node.name.text,
				kind: "function",
				startLine: lineOf(source, node.getStart()),
				endLine: endLineOf(source, node),
				exported: hasExportModifier(node),
			});
			// Visit children for nested functions (methods covered separately)
			ts.forEachChild(node.body ?? node, visit);
			return;
		}

		// export class / abstract class
		if (ts.isClassDeclaration(node) && node.name) {
			const classStart = lineOf(source, node.getStart());
			const classEnd = endLineOf(source, node);
			symbols.push({
				name: node.name.text,
				kind: "class",
				startLine: classStart,
				endLine: classEnd,
				exported: hasExportModifier(node),
			});
			// Extract methods and properties
			for (const member of node.members) {
				if (
					ts.isMethodDeclaration(member) ||
					ts.isGetAccessorDeclaration(member) ||
					ts.isSetAccessorDeclaration(member)
				) {
					const name = member.name;
					if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
						symbols.push({
							name: ts.isIdentifier(name) ? name.text : name.text,
							kind: "method",
							startLine: lineOf(source, member.getStart()),
							endLine: endLineOf(source, member),
							exported: false,
						});
					}
				} else if (ts.isPropertyDeclaration(member)) {
					const name = member.name;
					if (ts.isIdentifier(name)) {
						symbols.push({
							name: name.text,
							kind: "property",
							startLine: lineOf(source, member.getStart()),
							endLine: endLineOf(source, member),
							exported: false,
						});
					}
				}
			}
			return;
		}

		// export interface
		if (ts.isInterfaceDeclaration(node)) {
			symbols.push({
				name: node.name.text,
				kind: "interface",
				startLine: lineOf(source, node.getStart()),
				endLine: endLineOf(source, node),
				exported: hasExportModifier(node),
			});
			return;
		}

		// export type
		if (ts.isTypeAliasDeclaration(node)) {
			symbols.push({
				name: node.name.text,
				kind: "type",
				startLine: lineOf(source, node.getStart()),
				endLine: endLineOf(source, node),
				exported: hasExportModifier(node),
			});
			return;
		}

		// export const / let / var
		if (ts.isVariableStatement(node)) {
			const exported = hasExportModifier(node);
			for (const decl of node.declarationList.declarations) {
				if (!ts.isIdentifier(decl.name)) continue;
				const name = decl.name.text;
				// Arrow function → treat as function kind
				const isArrow =
					decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));
				const kind: SymbolKind = isArrow
					? "function"
					: node.declarationList.flags & ts.NodeFlags.Const
						? "const"
						: "variable";
				symbols.push({
					name,
					kind,
					startLine: lineOf(source, node.getStart()),
					endLine: endLineOf(source, decl),
					exported,
				});
			}
			return;
		}

		// Recurse into module declarations and namespaces
		if (ts.isModuleDeclaration(node) || ts.isModuleBlock(node)) {
			ts.forEachChild(node, visit);
			return;
		}

		// Top-level only — don't recurse into function bodies
		if (ts.isSourceFile(node)) {
			ts.forEachChild(node, visit);
		}
	}

	ts.forEachChild(source, visit);
	return symbols;
}

// ---------------------------------------------------------------------------
// File extension check
// ---------------------------------------------------------------------------

export function isTsFile(path: string): boolean {
	return path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".mts") || path.endsWith(".cts");
}
