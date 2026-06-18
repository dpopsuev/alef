#!/usr/bin/env node

/**
 * Identifies functions over 50 lines in TypeScript files.
 * Scans all .ts files in packages slash star slash src directories (excluding node_modules, dist, test).
 * Counts lines per function/method (including blank lines and comments within the function body).
 * Output: filepath:line:functionName:lineCount (sorted by line count descending)
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT_DIR = process.cwd();
const MIN_LINES = 50;

/**
 * Recursively find all .ts files in a directory
 */
function findTypeScriptFiles(dir, files = []) {
	const entries = readdirSync(dir, { withFileTypes: true });
	
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		
		// Skip excluded directories
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || 
			    entry.name === 'dist' || 
			    entry.name === 'test' ||
			    entry.name === '__tests__') {
				continue;
			}
			findTypeScriptFiles(fullPath, files);
		} else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
			files.push(fullPath);
		}
	}
	
	return files;
}

/**
 * Get all packages star src directories
 */
function getPackageSrcDirs() {
	const packagesDir = join(ROOT_DIR, 'packages');
	const dirs = [];
	
	try {
		const packageDirs = readdirSync(packagesDir, { withFileTypes: true });
		for (const entry of packageDirs) {
			if (entry.isDirectory()) {
				const srcPath = join(packagesDir, entry.name, 'src');
				try {
					if (statSync(srcPath).isDirectory()) {
						dirs.push(srcPath);
					}
				} catch (e) {
					// src directory doesn't exist, skip
				}
			}
		}
	} catch (e) {
		console.error('Error reading packages directory:', e.message);
		process.exit(1);
	}
	
	return dirs;
}

/**
 * Find matching closing brace for an opening brace
 */
function findClosingBrace(lines, startLine, startCol) {
	let depth = 0;
	let foundOpening = false;
	
	for (let i = startLine; i < lines.length; i++) {
		const line = lines[i];
		const startPos = (i === startLine) ? startCol : 0;
		
		for (let j = startPos; j < line.length; j++) {
			const char = line[j];
			
			if (char === '{') {
				depth++;
				foundOpening = true;
			} else if (char === '}') {
				depth--;
				if (foundOpening && depth === 0) {
					return i;
				}
			}
			
			// Skip string contents
			if (char === '"' || char === "'" || char === '`') {
				const quote = char;
				j++;
				while (j < line.length) {
					if (line[j] === '\\') {
						j += 2;
						continue;
					}
					if (line[j] === quote) {
						break;
					}
					j++;
				}
			}
		}
	}
	
	return -1;
}

/**
 * Extract function name from function declaration
 */
function extractFunctionName(line, context) {
	// Method declaration: methodName(...) {
	let match = line.match(/^\s*(?:async\s+)?(?:public\s+|private\s+|protected\s+|static\s+)*(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/);
	if (match) {
		return context.className ? `${context.className}.${match[1]}` : match[1];
	}
	
	// Constructor
	if (line.match(/^\s*constructor\s*\(/)) {
		return context.className ? `${context.className}.constructor` : 'constructor';
	}
	
	// Function declaration: function name(...) {
	match = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
	if (match) {
		return match[1];
	}
	
	// Arrow function: const name = (...) => {
	match = line.match(/^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>/);
	if (match) {
		return match[1];
	}
	
	// Property with arrow function: name = (...) => {
	match = line.match(/^\s*(?:readonly\s+|public\s+|private\s+|protected\s+|static\s+)*(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>/);
	if (match) {
		return context.className ? `${context.className}.${match[1]}` : match[1];
	}
	
	return '(anonymous)';
}

/**
 * Check if a line starts a function
 */
function isFunctionStart(line) {
	// Remove leading whitespace
	const trimmed = line.trim();
	
	// Skip empty lines and comments
	if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
		return false;
	}
	
	// Function declaration
	if (/^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/.test(line)) {
		return true;
	}
	
	// Method declaration
	if (/^\s*(?:async\s+)?(?:public\s+|private\s+|protected\s+|static\s+)*\w+\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/.test(line)) {
		return true;
	}
	
	// Constructor
	if (/^\s*constructor\s*\(/.test(line)) {
		return true;
	}
	
	// Arrow function assignment
	if (/^\s*(?:export\s+)?const\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>/.test(line)) {
		return true;
	}
	
	// Property with arrow function
	if (/^\s*(?:readonly\s+|public\s+|private\s+|protected\s+|static\s+)*\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>/.test(line)) {
		return true;
	}
	
	return false;
}

/**
 * Analyze a TypeScript file and extract function information
 */
function analyzeFile(filePath) {
	const results = [];
	const content = readFileSync(filePath, 'utf8');
	const lines = content.split('\n');
	
	let context = {
		className: null,
		classDepth: 0
	};
	
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		
		// Track class context
		const classMatch = line.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
		if (classMatch) {
			context.className = classMatch[1];
			context.classDepth = 0;
		}
		
		// Check if this line starts a function
		if (isFunctionStart(line)) {
			const functionName = extractFunctionName(line, context);
			
			// Find the opening brace
			const braceCol = line.indexOf('{');
			if (braceCol !== -1) {
				// Find closing brace
				const closingLine = findClosingBrace(lines, i, braceCol);
				
				if (closingLine !== -1) {
					const lineCount = closingLine - i + 1;
					
					if (lineCount >= MIN_LINES) {
						results.push({
							filePath: relative(ROOT_DIR, filePath),
							line: i + 1,
							functionName,
							lineCount
						});
					}
				}
			}
		}
		
		// Reset class context when leaving class
		if (context.className) {
			const openBraces = (line.match(/\{/g) || []).length;
			const closeBraces = (line.match(/\}/g) || []).length;
			context.classDepth += openBraces - closeBraces;
			
			if (context.classDepth < 0) {
				context.className = null;
				context.classDepth = 0;
			}
		}
	}
	
	return results;
}

/**
 * Main execution
 */
function main() {
	console.log('Scanning for functions over 50 lines in packages/star/src...\n');
	
	const srcDirs = getPackageSrcDirs();
	console.log(`Found ${srcDirs.length} package src directories\n`);
	
	// Collect all TypeScript files
	const allFiles = [];
	for (const dir of srcDirs) {
		const files = findTypeScriptFiles(dir);
		allFiles.push(...files);
	}
	
	console.log(`Analyzing ${allFiles.length} TypeScript files...\n`);
	
	// Analyze all files
	const allResults = [];
	for (const file of allFiles) {
		try {
			const results = analyzeFile(file);
			allResults.push(...results);
		} catch (e) {
			console.error(`Error analyzing ${file}: ${e.message}`);
		}
	}
	
	// Sort by line count descending
	allResults.sort((a, b) => b.lineCount - a.lineCount);
	
	// Output results
	console.log('Functions over 50 lines:\n');
	console.log('─'.repeat(80));
	
	if (allResults.length === 0) {
		console.log('No functions over 50 lines found.');
	} else {
		for (const result of allResults) {
			console.log(`${result.filePath}:${result.line}:${result.functionName}:${result.lineCount}`);
		}
		console.log('─'.repeat(80));
		console.log(`\nTotal: ${allResults.length} functions over ${MIN_LINES} lines`);
	}
}

main();
