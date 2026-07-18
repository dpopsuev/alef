/**
 * Shim: native tree-sitter SyntaxNode -> CodeGraph TreeSitterNode/TreeSitterTree.
 *
 * The native `Parser.SyntaxNode` from the `tree-sitter` npm package is
 * structurally compatible with CodeGraph's `TreeSitterNode` interface.
 * Both expose: type, text, isNamed, startPosition, endPosition, child(),
 * namedChild(), childForFieldName(), parent, children, namedChildren, etc.
 *
 * A direct cast is safe because the shapes match.
 */

import type Parser from "tree-sitter";
import type { TreeSitterTree } from "./types.js";

/** Wrap a native tree-sitter Tree as a CodeGraph TreeSitterTree. */
export function wrapTree(tree: Parser.Tree): TreeSitterTree {
	return tree;
}
