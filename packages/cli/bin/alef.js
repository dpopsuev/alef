#!/usr/bin/env node
/**
 * Alef CLI entry point.
 *
 * Requires a prior build (npm run build). Always runs compiled output.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
await import(resolve(__dirname, "../dist/entrypoint.js"));
