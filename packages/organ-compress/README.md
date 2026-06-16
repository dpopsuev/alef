# organ-compress

Context compression organ for Alef framework - reduces conversation token usage via multi-level summarization.

## Features

- **Multi-level summarization**: Extracts key facts and discards verbosity
- **Token estimation**: Rough estimation using 4 chars = 1 token rule
- **Storage**: Stores both original and compressed versions for retrieval
- **Statistics**: Tracks compression ratios and token savings

## Tools

### `compress.turn(turnIndex, text)`

Compress a single conversation turn to reduce token usage while preserving key information.

**Parameters:**
- `turnIndex` (number): The index of the turn to compress (0-based)
- `text` (string): The text content of the turn to compress

**Returns:**
- `turnIndex`: The compressed turn index
- `compressed`: The compressed text
- `originalTokens`: Token count before compression
- `compressedTokens`: Token count after compression
- `compressionRatio`: Ratio of compressed to original (< 1.0 means compression)

### `compress.batch(startTurn, endTurn, turns)`

Compress a range of conversation turns in batch for better efficiency.

**Parameters:**
- `startTurn` (number): Starting turn index (inclusive)
- `endTurn` (number): Ending turn index (inclusive)
- `turns` (string[]): Array of turn texts to compress

**Returns:**
- `results`: Array of per-turn compression stats
- `totalOriginalTokens`: Sum of original token counts
- `totalCompressedTokens`: Sum of compressed token counts
- `overallCompressionRatio`: Overall compression ratio

### `compress.summary()`

Get compression statistics across all compressed turns.

**Parameters:** None

**Returns:**
- `totalOriginalTokens`: Total original token count
- `totalCompressedTokens`: Total compressed token count
- `compressionRatio`: Overall compression ratio
- `turnCount`: Number of turns compressed

## Compression Algorithm

The compression algorithm uses information density scoring:

1. **Split into sentences**: Basic sentence segmentation
2. **Extract key patterns**: Prioritize sentences containing:
   - Error/success keywords (error, warning, success, failed, etc.)
   - Numbers (counts, sizes, metrics)
   - File paths and extensions
   - Command verbs (run, execute, build, test, etc.)
3. **Discard low-information content**: Remove filler sentences
4. **Fallback strategy**: If all sentences are filtered out, keep first and last
5. **Compression threshold**: Only return compressed version if >20% size reduction

## Usage Example

```typescript
import { createCompressOrgan } from "@dpopsuev/alef-organ-compress";

const organ = createCompressOrgan({ cwd: process.cwd() });
// Add to your agent's blueprint organs list
```

## Installation

```bash
npm install @dpopsuev/alef-organ-compress
```

## Testing

```bash
npm test
```

All tests use the framework compliance suite to ensure proper integration with the Alef kernel.

## Implementation Notes

- Token estimation is approximate (4 characters ≈ 1 token)
- Compressed versions are stored in memory (not persisted to disk)
- Display output uses `withDisplay` for TUI-friendly formatting
- All tools use `typedAction` with Zod schema validation
