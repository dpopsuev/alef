# @example/alef-provider-ollama

Example provider plugin for Alef — demonstrates the `ProviderFactory` contract.

## Install

```bash
alef install @example/alef-provider-ollama
```

## What it does

Registers an Ollama LLM provider with the Alef registry. After install:

- `alef --list-models` shows Ollama models (llama3.3, qwen3, deepseek-r1, mistral, codestral)
- `alef --model ollama/llama3.3` uses Ollama for inference
- Requires Ollama running locally at `http://localhost:11434`

## Provider contract

A provider package must:

1. Declare `"alef": { "type": "provider", "entry": "./src/index.ts" }` in `package.json`
2. Export `createProvider: ProviderFactory` from the entry point
3. Return `{ providers: ApiProvider[], models: ProviderModelDefinition[] }`

The installer reads the manifest, calls `createProvider()`, and wires everything.

## Types

```typescript
import type { ApiProvider } from "@dpopsuev/alef-llm/provider-port";
import type { ProviderFactory } from "@dpopsuev/alef-llm/provider-contract";
import type { Model, Context, StreamOptions } from "@dpopsuev/alef-llm/types";
```
