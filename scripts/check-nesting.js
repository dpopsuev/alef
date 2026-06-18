#!/usr/bin/env node
/**
 * Measures nesting depth per function in TypeScript files.
 * 
 * Scans all .ts files in packages/STAR/src directories (excluding node_modules, dist, test)
 * and reports functions sorted by worst nesting depth.
 * 
 * Usage:
 *   node scripts/check-nesting.js [--threshold=N] [--top=N]
 * 
 * Options:
 *   --threshold=N  Only report functions with depth >= N (default: 0)
 *   --top=N        Limit output to top N deepest functions (default: all)
 *   --json         Output results as JSON
 *   --verbose      Show detailed debug information
 * 
 * Output format: filepath:line:functionName:depth
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { parse } from '@typescript-eslint/parser';

const root = fileURLToPath(new URL('..', import.meta.url));

// Parse CLI arguments
const args = process.argv.slice(2);
const threshold = parseInt(args.find(a => a.startsWith('--threshold='))?.split('=')[1] || '0', 10);
const topN = parseInt(args.find(a => a.startsWith('--top='))?.split('=')[1] || '0', 10);
const jsonOutput = args.includes('--json');
const verbose = args.includes('--verbose');

/**
 * Recursively find all .ts files in packages/STAR/src directories
 */
function findTypeScriptFiles() {
	const files = [];
	const packagesDir = join(root, 'packages');
	
	if (!statSync(packagesDir, { throwIfNoEntry: false })?.isDirectory()) {
		return files;
	}
	
	const packages = readdirSync(packagesDir)
		.map(name => join(packagesDir, name))
		.filter(dir => statSync(dir, { throwIfNoEntry: false })?.isDirectory());
	
	for (const pkgDir of packages) {
		const srcDir = join(pkgDir, 'src');
		if (statSync(srcDir, { throwIfNoEntry: false })?.isDirectory()) {
			collectTsFiles(srcDir, files);
		}
	}
	
	return files;
}

/**
 * Recursively collect .ts files, excluding test directories
 */
function collectTsFiles(dir, files) {
	const entries = readdirSync(dir, { withFileTypes: true });
	
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		
		// Skip excluded directories
		if (entry.isDirectory()) {
			const name = entry.name.toLowerCase();
			if (name === 'node_modules' || name === 'dist' || name === 'test' || name === '__tests__') {
				continue;
			}
			collectTsFiles(fullPath, files);
		} else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
			// Skip test files
			if (!entry.name.includes('.test.') && !entry.name.includes('.spec.')) {
				files.push(fullPath);
			}
		}
	}
}

/**
 * Nodes that increase nesting depth
 */
const NESTING_NODES = [
	'IfStatement',
	'ForStatement',
	'ForInStatement',
	'ForOfStatement',
	'WhileStatement',
	'DoWhileStatement',
	'SwitchStatement',
	'CatchClause',
	'WithStatement',
];

/**
 * Find all functions in AST and calculate their max nesting depth
 */
function findFunctions(node, results = []) {
	if (!node || typeof node !== 'object') {
		return results;
	}
	
	const isFunctionNode = [
		'FunctionDeclaration',
		'FunctionExpression',
		'ArrowFunctionExpression',
		'MethodDefinition',
	].includes(node.type);
	
	if (isFunctionNode) {
		const name = getFunctionName(node);
		const line = node.loc?.start.line || 0;
		
		// Get the function body
		let body = null;
		if (node.type === 'MethodDefinition') {
			body = node.value?.body;
		} else {
			body = node.body;
		}
		
		// Calculate max nesting depth in this function
		const maxDepth = body ? getMaxNestingDepth(body, 0) : 0;
		
		results.push({
			name,
			line,
			depth: maxDepth,
		});
		
		if (verbose && maxDepth > 0) {
			console.error(`  ${name} at line ${line}: depth ${maxDepth}`);
		}
	}
	
	// Recursively visit children
	for (const key of Object.keys(node)) {
		if (key === 'loc' || key === 'range' || key === 'parent') {
			continue;
		}
		
		const child = node[key];
		if (Array.isArray(child)) {
			for (const item of child) {
				findFunctions(item, results);
			}
		} else if (child && typeof child === 'object') {
			findFunctions(child, results);
		}
	}
	
	return results;
}

/**
 * Calculate maximum nesting depth within a node
 */
function getMaxNestingDepth(node, currentDepth = 0) {
	if (!node || typeof node !== 'object') {
		return currentDepth;
	}
	
	// Stop at nested function boundaries
	const isFunctionNode = [
		'FunctionDeclaration',
		'FunctionExpression',
		'ArrowFunctionExpression',
	].includes(node.type);
	
	if (isFunctionNode) {
		// Don't traverse into nested functions
		return currentDepth;
	}
	
	// Check if this node increases nesting
	const isNestingNode = NESTING_NODES.includes(node.type);
	const nextDepth = isNestingNode ? currentDepth + 1 : currentDepth;
	
	let maxDepth = nextDepth;
	
	// Recursively check all children
	for (const key of Object.keys(node)) {
		if (key === 'loc' || key === 'range' || key === 'parent') {
			continue;
		}
		
		const child = node[key];
		if (Array.isArray(child)) {
			for (const item of child) {
				const childDepth = getMaxNestingDepth(item, nextDepth);
				if (childDepth > maxDepth) {
					maxDepth = childDepth;
				}
			}
		} else if (child && typeof child === 'object') {
			const childDepth = getMaxNestingDepth(child, nextDepth);
			if (childDepth > maxDepth) {
				maxDepth = childDepth;
			}
		}
	}
	
	return maxDepth;
}

/**
 * Extract a meaningful name for a function/method
 */
function getFunctionName(node) {
	if (node.type === 'FunctionDeclaration') {
		return node.id?.name || '<anonymous>';
	}
	
	if (node.type === 'MethodDefinition') {
		const key = node.key;
		if (key.type === 'Identifier') {
			return key.name;
		}
		if (key.type === 'Literal') {
			return String(key.value);
		}
		return '<computed>';
	}
	
	if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
		// Try to infer name from parent context
		if (node.id?.name) {
			return node.id.name;
		}
		// Check if it's a variable declaration
		if (node.parent?.type === 'VariableDeclarator' && node.parent.id?.name) {
			return node.parent.id.name;
		}
		// Check if it's a property
		if (node.parent?.type === 'Property' && node.parent.key) {
			if (node.parent.key.type === 'Identifier') {
				return node.parent.key.name;
			}
		}
		// Check if it's an assignment
		if (node.parent?.type === 'AssignmentExpression' && node.parent.left) {
			if (node.parent.left.type === 'Identifier') {
				return node.parent.left.name;
			}
			if (node.parent.left.type === 'MemberExpression') {
				const prop = node.parent.left.property;
				if (prop?.type === 'Identifier') {
					return prop.name;
				}
			}
		}
		return '<arrow>';
	}
	
	return '<unknown>';
}

/**
 * Add parent references to AST nodes for better context
 */
function addParentReferences(node, parent = null) {
	if (!node || typeof node !== 'object') {
		return;
	}
	
	node.parent = parent;
	
	for (const key of Object.keys(node)) {
		if (key === 'parent' || key === 'loc' || key === 'range') {
			continue;
		}
		
		const child = node[key];
		if (Array.isArray(child)) {
			for (const item of child) {
				addParentReferences(item, node);
			}
		} else if (child && typeof child === 'object') {
			addParentReferences(child, node);
		}
	}
}

/**
 * Analyze a single TypeScript file
 */
function analyzeFile(filePath) {
	try {
		const content = readFileSync(filePath, 'utf-8');
		const ast = parse(content, {
			loc: true,
			range: true,
			ecmaVersion: 'latest',
			sourceType: 'module',
			ecmaFeatures: {
				jsx: true,
			},
		});
		
		// Add parent references for better name inference
		addParentReferences(ast);
		
		const results = findFunctions(ast);
		const relativePath = relative(root, filePath);
		
		return results.map(r => ({
			file: relativePath,
			line: r.line,
			name: r.name,
			depth: r.depth,
		}));
	} catch (error) {
		if (!jsonOutput) {
			console.error(`Error parsing ${filePath}:`, error.message);
		}
		return [];
	}
}

/**
 * Main execution
 */
function main() {
	const files = findTypeScriptFiles();
	
	if (files.length === 0) {
		console.error('No TypeScript files found in packages directories');
		process.exit(1);
	}
	
	if (!jsonOutput) {
		console.error(`Analyzing ${files.length} TypeScript files...`);
	}
	
	const allResults = [];
	for (const file of files) {
		const results = analyzeFile(file);
		allResults.push(...results);
	}
	
	// Filter by threshold
	const filtered = allResults.filter(r => r.depth >= threshold);
	
	// Sort by depth (descending), then by file and line
	filtered.sort((a, b) => {
		if (b.depth !== a.depth) return b.depth - a.depth;
		if (a.file !== b.file) return a.file.localeCompare(b.file);
		return a.line - b.line;
	});
	
	// Apply top-N limit if specified
	const output = topN > 0 ? filtered.slice(0, topN) : filtered;
	
	if (jsonOutput) {
		console.log(JSON.stringify({
			total: allResults.length,
			filtered: filtered.length,
			threshold,
			results: output,
		}, null, 2));
	} else {
		console.error('');
		console.error(`Found ${allResults.length} functions, ${filtered.length} with depth >= ${threshold}`);
		console.error('');
		
		if (output.length === 0) {
			console.log('No results to display');
		} else {
			for (const result of output) {
				console.log(`${result.file}:${result.line}:${result.name}:${result.depth}`);
			}
		}
		
		if (topN > 0 && filtered.length > topN) {
			console.error('');
			console.error(`(showing top ${topN} of ${filtered.length} results)`);
		}
	}
}

main();
