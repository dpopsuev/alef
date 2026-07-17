# @dpopsuev/alef-organ-code-intel

Code Intelligence adapter with AST-based search and knowledge graph.

## Features

- **AST Tools**: code.ast.match and code.ast.extract for structural code search
- **Graph Backend**: SQLite knowledge graph for symbols, calls, and dependencies
- **LSP Integration**: TypeScript/JavaScript symbol navigation
- **Tree-sitter**: Polyglot parsing for 40+ languages

## Tools

- `code.ast.match` - Search symbols by pattern with wildcards
- `code.ast.extract` - Extract full symbol definitions
- `code.symbols` - LSP workspace symbol search
- `code.callers` - Find all call sites
- `code.dependencies` - Module dependency analysis
- `code.references` - Find all references to a symbol
