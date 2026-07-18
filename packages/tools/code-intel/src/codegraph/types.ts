/**
 * Vendored type subset from CodeGraph (Apache-2.0, github.com/optave/ops-codegraph-tool).
 * Only the interfaces and types needed by the extractor pure-function library.
 */

export interface TreeSitterQuery {
  matches(node: TreeSitterNode): TreeSitterQueryMatch[];
  captures(node: TreeSitterNode): TreeSitterQueryCapture[];
}
export interface TreeSitterQueryMatch {
  pattern: number;
  captures: TreeSitterQueryCapture[];
}
export interface TreeSitterQueryCapture {
  name: string;
  node: TreeSitterNode;
}

export type CoreSymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'struct'
  | 'enum'
  | 'trait'
  | 'record'
  | 'module'
  | 'namespace';
export type ExtendedSymbolKind = 'parameter' | 'property' | 'constant' | 'variable' | 'method';
export type SymbolKind = CoreSymbolKind | ExtendedSymbolKind;
export interface Definition {
  name: string;
  kind: SymbolKind;
  line: number;
  endLine?: number;
  children?: SubDeclaration[];
  visibility?: 'public' | 'private' | 'protected';
  decorators?: string[];
  /**
   * Set by the extractor when the underlying AST node structurally has no
   * executable body (e.g. a TS `method_signature`, a Go interface
   * `method_elem`, an abstract/interface method with no block, a Rust trait
   * `function_signature_item`). This is a direct signal from the grammar —
   * not inferred from name shape — so it stays correct for dotted names that
   * denote real bodied methods (Lua's `M.foo`, Go/Java/C#/PHP/Rust receiver
   * or impl methods, any `Class.method` qualified name).
   */
  bodyless?: boolean;
  /** Populated post-analysis by the complexity visitor. */
  complexity?: DefinitionComplexity;
  /** Populated post-analysis by the CFG visitor. */
  cfg?: { blocks: CfgBlock[]; edges: CfgEdge[] } | null;
}
export interface SubDeclaration {
  name: string;
  kind: 'parameter' | 'property' | 'constant' | 'method';
  line: number;
  endLine?: number;
  visibility?: 'public' | 'private' | 'protected';
  decorators?: string[];
}
export interface DefinitionComplexity {
  cognitive: number;
  cyclomatic: number;
  maxNesting: number;
  halstead?: HalsteadDerivedMetrics | HalsteadMetrics;
  loc?: LOCMetrics;
  maintainabilityIndex?: number;
}
export interface HalsteadMetrics {
  volume: number;
  difficulty: number;
  effort: number;
  bugs: number;
}
export interface HalsteadDerivedMetrics extends HalsteadMetrics {
  n1: number;
  n2: number;
  bigN1: number;
  bigN2: number;
  vocabulary: number;
  length: number;
}
export interface LOCMetrics {
  loc: number;
  sloc: number;
  commentLines: number;
}
export type DynamicKind =
  | 'computed-literal' // obj["foo"]()    — resolvable; already emitted as normal edge
  | 'computed-key' // obj[k]()        — potentially resolvable via pts; else flagged
  | 'reflection' // .call/.apply/.bind / Reflect.* / callable-ref — resolved when target is in codebase; sink edge emitted if unresolved
  | 'eval' // eval() / new Function() — undecidable; always flagged
  | 'unresolved-dynamic' // any other detected dynamic pattern; flagged
  | 'value-ref' // bare identifier used as a value reference rather than a call site — object-literal property value (dispatch-table pattern, e.g. `{ resolve: someFn }`, #1771), assignment to a Lua global/builtin identifier (e.g. `require = tracedRequire`, #1776), or the right operand of an `instanceof` check (e.g. `err instanceof CodegraphError`, #1784) — resolved against function/method/class-kind targets; class was added for instanceof, but the filter is per-kind rather than per-site, so all three sites share the same allow-list; unresolved (e.g. plain data references) are dropped silently, NOT flagged
  | 'dispatch-table'; // inline object-literal subscript dispatch, e.g. `({a:fnA,b:fnB})[key]()` (#1897) — resolved via the points-to wildcard solver against synthetic `<dt_line_col>[*]` array-elem bindings seeded from each property's identifier value; never flagged (excluded from FLAG_ONLY_DYNAMIC_KINDS) so an unresolved table produces no sink edge, matching the named-array `[fn1,fn2][*]` dispatch pattern

/** A function/method call detected by an extractor. */
export interface Call {
  name: string;
  line: number;
  receiver?: string;
  dynamic?: boolean;
  dynamicKind?: DynamicKind;
  keyExpr?: string;
}

export interface Import {
  source: string;
  names: string[];
  line: number;
  // Standard flags
  typeOnly?: boolean;
  reexport?: boolean;
  wildcardReexport?: boolean;
  dynamicImport?: boolean;
  /**
   * For `import { X as Y }` specifiers: the local binding name (Y) mapped to
   * the original name exported by the source module (X). `names` always
   * carries the local (post-rename) binding — this field lets call-edge
   * resolution recover the *original* symbol name to look up in the imported
   * file when a call site uses the local alias (#1730). Only populated for
   * specifiers that actually rename a binding; entries where local === source
   * name are omitted.
   *
   * Also populated for `export { X as Y } from …` reexport specifiers: `local`
   * is the external name (Y) a consumer of *this* barrel would import, and
   * `imported` is the name (X) actually declared in the source module. `names`
   * keeps carrying the original declaration name (X) for reexports (see
   * `extractImportNames`), so `resolveBarrelExport` uses this map to translate
   * a consumer's requested external name back to X before matching against
   * `names`/looking up the underlying definition (#1823).
   *
   * Also populated for dynamic `import()` destructuring renames
   * (`const { X: Y } = await import(...)`): same local/original split as the
   * static case, produced by `extractDynamicImportNames` (#1824).
   */
  renamedImports?: Array<{ local: string; imported: string }>;
  /**
   * Local binding names (post-alias, matching entries in `names`) that carry
   * an inline per-specifier `type`/`typeof` modifier (`import { type X }`),
   * as distinct from a whole-statement `import type { X }` (already covered
   * by `typeOnly`). Only populated for specifiers that actually use the
   * modifier — mirrors `renamedImports`'s sparse-population convention.
   * Lets a mixed statement (`import { value, type Foo }`) still credit `Foo`
   * with a symbol-level `imports-type` edge (#1813).
   */
  typeOnlyNames?: string[];
  // Language-specific flags (mutually exclusive at runtime)
  pythonImport?: boolean;
  goImport?: boolean;
  rustUse?: boolean;
  javaImport?: boolean;
  csharpUsing?: boolean;
  rubyRequire?: boolean;
  phpUse?: boolean;
  cInclude?: boolean;
  kotlinImport?: boolean;
  swiftImport?: boolean;
  scalaImport?: boolean;
  bashSource?: boolean;
}
export interface ClassRelation {
  name: string;
  extends?: string;
  implements?: string;
  line: number;
}
export interface Export {
  name: string;
  kind: SymbolKind;
  line: number;
}
export interface TypeMapEntry {
  type: string;
  confidence: number;
}
export interface CallAssignment {
  /** Variable being assigned to. */
  varName: string;
  /** Name of the function or method being called. */
  calleeName: string;
  /** Resolved receiver type, if the call is a method call (e.g. service.getRepo()). */
  receiverTypeName?: string;
}
export interface FnRefBinding {
  /** Variable being assigned (the left-hand side identifier). */
  lhs: string;
  /** Named function/property on the right-hand side. */
  rhs: string;
  /** If rhs is a member expression (obj.method), the receiver object name. */
  rhsReceiver?: string;
}
export interface ParamBinding {
  /** The function being called at the call site. */
  callee: string;
  /** Zero-based index of the argument. */
  argIndex: number;
  /** Identifier name of the argument being passed. */
  argName: string;
}
export interface ThisCallBinding {
  /** The function being invoked via .call() or .apply(). */
  callee: string;
  /** The identifier passed as the `this` context (first argument). */
  thisArg: string;
}
export interface ArrayElemBinding {
  arrayName: string;
  index: number;
  elemName: string;
}
export interface SpreadArgBinding {
  callee: string;
  arrayName: string;
  startIndex: number;
}
export interface ForOfBinding {
  varName: string;
  sourceName: string;
  enclosingFunc: string;
}
export interface ArrayCallbackBinding {
  sourceName: string;
  calleeName: string;
}
export interface ObjectRestParamBinding {
  /** Function that owns this rest parameter, e.g. "f3" */
  callee: string;
  /** Name of the rest binding, e.g. "eerest" */
  restName: string;
  /** Zero-based index of the argument whose rest is bound, e.g. 0 */
  argIndex: number;
}
export interface ObjectPropBinding {
  /** Variable holding the object, e.g. "obj" */
  objectName: string;
  /** Property name, e.g. "e4" */
  propName: string;
  /** Named function value, e.g. "e4" or "fn" */
  valueName: string;
}
export interface ExtractorOutput {
  definitions: Definition[];
  calls: Call[];
  imports: Import[];
  classes: ClassRelation[];
  exports: Export[];
  typeMap: Map<string, TypeMapEntry>;
  /**
   * Maps function/method names to their declared or inferred return types.
   * Keys: plain name (e.g. "createUser") or qualified name (e.g. "UserService.getUser").
   * Populated by JS/TS extractor; used for inter-procedural type propagation (Phase 8.2).
   */
  returnTypeMap?: Map<string, TypeMapEntry>;
  /**
   * Variable assignments from call expressions that could not be resolved from the
   * per-file returnTypeMap. Consumed by build-edges.ts to propagate cross-file return types.
   */
  callAssignments?: CallAssignment[];
  /**
   * Function-reference bindings for points-to analysis (Phase 8.3).
   * Records `const fn = handler` and `const fn = obj.method` patterns so the
   * edge builder can follow aliases when a call target has no direct definition.
   */
  fnRefBindings?: FnRefBinding[];
  /**
   * Argument-to-parameter bindings for parameter-flow points-to analysis (Phase 8.3c).
   * Records `f(x)` call sites where `x` is an identifier, enabling the pts solver
   * to propagate function references through function parameters.
   */
  paramBindings?: ParamBinding[];
  /** Phase 8.3e: array-element bindings from `const arr = [fn1, fn2]` patterns. */
  arrayElemBindings?: ArrayElemBinding[];
  /** Phase 8.3e: spread-argument bindings from `f(...arr)` call sites. */
  spreadArgBindings?: SpreadArgBinding[];
  /** Phase 8.3e: for-of iteration variable bindings. */
  forOfBindings?: ForOfBinding[];
  /** Phase 8.3e: array callback bindings from Array.from/forEach/etc. */
  arrayCallbackBindings?: ArrayCallbackBinding[];
  /** Phase 8.3f: object-rest parameter bindings from `function f({ ...rest })` patterns. */
  objectRestParamBindings?: ObjectRestParamBinding[];
  /** Phase 8.3f: object-property bindings from `const obj = { fn }` patterns. */
  objectPropBindings?: ObjectPropBinding[];
  /**
   * This-context bindings from `fn.call(namedCtx, ...)` / `fn.apply(namedCtx, ...)`.
   * Seeds `fn::this → namedCtx` in the points-to map so that `this()` calls inside
   * `fn` resolve to `namedCtx` when `fn` is invoked via `.call()`/`.apply()`.
   */
  thisCallBindings?: ThisCallBinding[];
  /**
   * Phase 8.5 (RTA): constructor names from all `new X()` expressions in the file,
   * including unassigned ones (e.g. `doSomething(new Foo())`). Used to build the
   * project-wide instantiated-types set for Rapid Type Analysis filtering.
   */
  newExpressions?: readonly string[];
  /**
   * Object.defineProperty receiver bindings: maps function name → target object name.
   * Records `Object.defineProperty(obj, "bar", { get: getter })` so the edge builder
   * can resolve `this.X()` calls inside `getter` as `obj.X()` (this === obj when the
   * accessor is invoked through the property).
   *
   * Example: `Object.defineProperty(obj, "bar", { get: getter })` emits
   * `definePropertyReceivers.set("getter", "obj")`.
   */
  definePropertyReceivers?: Map<string, string>;
  /**
   * CJS require bindings from `const { X, Y } = require('./path')` patterns.
   * Used by buildImportedNamesMap to classify X and Y as import artifacts so
   * receiver-edge resolution falls back to the global class lookup rather than
   * treating the destructured-binding function node as a local definition (#1661).
   * Does NOT cause DB import edges — use `imports` for that.
   */
  cjsRequireBindings?: Array<{ names: string[]; source: string }>;
  /** WASM tree retained for downstream analysis (complexity, CFG, dataflow). */
  _tree?: TreeSitterTree;
  /** Language identifier. */
  _langId?: string;
  /** Line count for metrics. */
  _lineCount?: number;
  /** Dataflow results, populated post-analysis. */
  dataflow?: unknown;
  /** AST node rows, populated post-analysis. */
  astNodes?: unknown[];
  /** Set when typeMap was backfilled from WASM for a native parse result. */
  _typeMapBackfilled?: boolean;
}
export interface TreeSitterNode {
  id: number;
  type: string;
  text: string;
  /**
   * Whether this node is a named grammar production vs. an anonymous token
   * (keyword/punctuation). Tree-sitter grammars can define an anonymous
   * token whose text matches a *named* node's type string — e.g.
   * tree-sitter-typescript's `predefined_type` wraps an anonymous `string`
   * keyword token that collides with the named `string` literal node type
   * (#1729). Consumers matching by `type` alone must also check `isNamed`
   * to avoid misclassifying keyword tokens as literal/expression nodes.
   */
  isNamed: boolean;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childCount: number;
  namedChildCount: number;
  child(index: number): TreeSitterNode | null;
  namedChild(index: number): TreeSitterNode | null;
  childForFieldName(name: string): TreeSitterNode | null;
  fieldNameForChild(index: number): string | null;
  parent: TreeSitterNode | null;
  previousSibling: TreeSitterNode | null;
  nextSibling: TreeSitterNode | null;
  children: TreeSitterNode[];
  namedChildren: TreeSitterNode[];
}
export interface TreeSitterTree {
  rootNode: TreeSitterNode;
}
export interface CfgBlock {
  id: number;
  label: string;
  startLine: number;
  endLine: number;
}
export interface CfgEdge {
  from: number;
  to: number;
  label?: string;
}
