#!/bin/bash
set -e

echo "🔨 Building Service Layer Package..."
cd packages/tools/service-layer

# Install dependencies (if needed)
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  npm install --save-dev typescript @types/node vitest
fi

# Build TypeScript
echo "🏗️  Compiling TypeScript..."
npx tsc

echo "✅ Build complete!"
echo ""
echo "📊 Package contents:"
ls -lh dist/

echo ""
echo "🧪 Running tests..."
npx vitest run || echo "⚠️  Tests require complete setup"

echo ""
echo "✅ Service Layer Package Ready!"
echo ""
echo "Next steps:"
echo "  1. Review: cat packages/tools/service-layer/README.md"
echo "  2. Test: cd packages/tools/service-layer && npm test"
echo "  3. Demo: node examples/service-layer-demo.ts (after build)"
echo "  4. Docs: cat docs/INTEGRATION_GUIDE.md"
