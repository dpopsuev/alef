#!/usr/bin/env node

/**
 * Diagnostic script to find single-letter variable names in production TypeScript code.
 * 
 * Scans all .ts files in packages/STAR/src directories and reports single-letter
 * variable/parameter names that should probably be more descriptive.
 * 
 * Usage:
 *   node scripts/check-single-letters.js
 *   node scripts/check-single-letters.js --verbose
 *   node scripts/check-single-letters.js --compact  (output as filepath:line:var:context)
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

// Single letters that are commonly acceptable:
// - i, j, k: loop counters
// - x, y, z: coordinates
// - _: explicitly unused parameters
// - e: error in catch blocks (contentious but common)
const ACCEPTABLE = new Set(['i', 'j', 'k', 'x', 'y', 'z', '_']);

// Context patterns to determine if a single letter is acceptable
const ACCEPTABLE_CONTEXTS = [
	// Standard for loops: for (let i = 0; i < n; i++)
	/for\s*\(\s*(?:let|var|const)?\s*([ijk])\s*=/i,
	// Array methods with index: .map((item, i) => ...)
	/\.\w+\([^,)]+,\s*([ijk])\s*\)/,
	// Coordinate-like patterns: {x, y} or (x, y)
	/[({]\s*([xy])\s*,\s*([xy])\s*[)}]/,
];

const results = [];
const fileStats = new Map();
const verbose = process.argv.includes('--verbose');
const compact = process.argv.includes('--compact');

/**
 * Extract single-letter identifiers from a parameter list
 */
function extractParamsFromList(paramList) {
	if (!paramList) return [];
	
	const params = [];
	// Split by comma, handling nested brackets/parens
	const parts = paramList.split(',').map(p => p.trim());
	
	for (const part of parts) {
		// Skip empty
		if (!part) continue;
		
		// Handle destructuring: { x, y }
		if (part.includes('{') || part.includes('[')) {
			const destructured = part.match(/([a-z])\b/gi);
			if (destructured) {
				params.push(...destructured.filter(p => p.length === 1));
			}
			continue;
		}
		
		// Extract parameter name (before : or = or end)
		const match = part.match(/^\s*(\w+)(?:\s*[:=?]|$)/);
		if (match && match[1].length === 1) {
			params.push(match[1]);
		}
	}
	
	return params;
}

/**
 * Check if a single-letter variable is in an acceptable context
 */
function isAcceptableContext(line, varName) {
	// Check if it's in the acceptable set
	if (ACCEPTABLE.has(varName.toLowerCase())) {
		return true;
	}
	
	// Special case: 'e' in catch blocks
	if (varName === 'e' && /catch\s*\(\s*e\s*\)/.test(line)) {
		return true;
	}
	
	// Check specific context patterns
	for (const pattern of ACCEPTABLE_CONTEXTS) {
		if (pattern.test(line)) {
			return true;
		}
	}
	
	return false;
}

/**
 * Analyze a TypeScript file for single-letter variable names
 */
function analyzeFile(filepath) {
	const content = readFileSync(filepath, 'utf8');
	const lines = content.split('\n');
	const findings = [];
	
	lines.forEach((line, index) => {
		const lineNum = index + 1;
		const trimmed = line.trim();
		
		// Skip comments
		if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
			return;
		}
		
		// Check const/let/var declarations
		const declMatch = /\b(?:const|let|var)\s+([a-z])\s*[=:;]/i.exec(line);
		if (declMatch) {
			const varName = declMatch[1];
			if (!isAcceptableContext(line, varName)) {
				findings.push({
					line: lineNum,
					varName,
					context: trimmed.substring(0, 80),
				});
			}
		}
		
		// Check function parameters
		const funcMatches = line.matchAll(/(?:function\s+\w+|async\s+function\s+\w+)\s*\(([^)]*)\)/g);
		for (const match of funcMatches) {
			const params = extractParamsFromList(match[1]);
			for (const param of params) {
				if (!isAcceptableContext(line, param)) {
					findings.push({
						line: lineNum,
						varName: param,
						context: trimmed.substring(0, 80),
					});
				}
			}
		}
		
		// Check arrow function parameters - single param without parens
		const arrowSingleMatch = /(?:^|[^\w])([a-z])\s*=>/i.exec(line);
		if (arrowSingleMatch && !line.includes('(')) {
			const varName = arrowSingleMatch[1];
			if (!isAcceptableContext(line, varName)) {
				findings.push({
					line: lineNum,
					varName,
					context: trimmed.substring(0, 80),
				});
			}
		}
		
		// Check arrow function parameters - with parens
		const arrowParensMatches = line.matchAll(/\(([^)]*)\)\s*=>/g);
		for (const match of arrowParensMatches) {
			const params = extractParamsFromList(match[1]);
			for (const param of params) {
				if (!isAcceptableContext(line, param)) {
					findings.push({
						line: lineNum,
						varName: param,
						context: trimmed.substring(0, 80),
					});
				}
			}
		}
		
		// Check for-of/for-in loops
		const forOfMatch = /\bfor\s*\(\s*(?:const|let|var)?\s*([a-z])\s+(?:of|in)\b/i.exec(line);
		if (forOfMatch) {
			const varName = forOfMatch[1];
			// For-of/in with non-standard names
			if (!ACCEPTABLE.has(varName.toLowerCase())) {
				findings.push({
					line: lineNum,
					varName,
					context: trimmed.substring(0, 80),
				});
			}
		}
	});
	
	return findings;
}

/**
 * Recursively find all .ts files in a directory
 */
function findTypeScriptFiles(dir, files = []) {
	const entries = readdirSync(dir, { withFileTypes: true });
	
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		
		if (entry.isDirectory()) {
			// Skip node_modules, dist, build, test directories
			if (['node_modules', 'dist', 'build', '.git'].includes(entry.name)) {
				continue;
			}
			// Skip test directories
			if (entry.name.includes('test') || entry.name.includes('__tests__')) {
				continue;
			}
			findTypeScriptFiles(fullPath, files);
		} else if (entry.isFile() && entry.name.endsWith('.ts')) {
			// Skip test files, declaration files
			if (entry.name.includes('.test.') || 
			    entry.name.includes('.spec.') ||
			    entry.name.endsWith('.d.ts')) {
				continue;
			}
			files.push(fullPath);
		}
	}
	
	return files;
}

/**
 * Main execution
 */
function main() {
	if (!compact) {
		console.log('🔍 Scanning for single-letter variable names in production TypeScript...\n');
	}
	
	const packagesDir = join(process.cwd(), 'packages');
	
	// Check if packages directory exists
	try {
		statSync(packagesDir);
	} catch (e) {
		console.error('❌ Error: packages/ directory not found');
		console.error('   Run this script from the repository root');
		process.exit(1);
	}
	
	// Find all package src directories
	const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
		.filter(dirent => dirent.isDirectory())
		.map(dirent => join(packagesDir, dirent.name, 'src'))
		.filter(srcDir => {
			try {
				statSync(srcDir);
				return true;
			} catch {
				return false;
			}
		});
	
	if (!compact) {
		console.log(`Found ${packageDirs.length} package src directories\n`);
	}
	
	// Scan each package
	let totalFiles = 0;
	let totalFindings = 0;
	
	for (const srcDir of packageDirs) {
		const files = findTypeScriptFiles(srcDir);
		totalFiles += files.length;
		
		for (const file of files) {
			const findings = analyzeFile(file);
			
			if (findings.length > 0) {
				const relPath = relative(process.cwd(), file);
				
				// Store stats
				if (!fileStats.has(relPath)) {
					fileStats.set(relPath, 0);
				}
				fileStats.set(relPath, fileStats.get(relPath) + findings.length);
				
				// Store results
				for (const finding of findings) {
					results.push({
						file: relPath,
						line: finding.line,
						varName: finding.varName,
						context: finding.context,
					});
					totalFindings++;
				}
			}
		}
	}
	
	// Sort files by count (descending)
	const sortedFiles = Array.from(fileStats.entries())
		.sort((a, b) => b[1] - a[1]);
	
	// Compact output format
	if (compact) {
		for (const result of results) {
			console.log(`${result.file}:${result.line}:${result.varName}:${result.context}`);
		}
		return;
	}
	
	// Output results
	console.log('═══════════════════════════════════════════════════════════════════\n');
	console.log(`📊 Summary: Found ${totalFindings} single-letter variables in ${fileStats.size} files (${totalFiles} files scanned)\n`);
	console.log('═══════════════════════════════════════════════════════════════════\n');
	
	if (totalFindings === 0) {
		console.log('✅ No problematic single-letter variables found!');
		return;
	}
	
	// Group by file and show sorted by count
	for (const [file, count] of sortedFiles) {
		console.log(`\n${file} (${count} findings):`);
		console.log('─'.repeat(70));
		
		const fileResults = results.filter(r => r.file === file);
		for (const result of fileResults) {
			console.log(`  Line ${result.line}: '${result.varName}'`);
			if (verbose) {
				console.log(`    ${result.context}`);
			}
		}
	}
	
	// Summary statistics
	console.log('\n═══════════════════════════════════════════════════════════════════');
	console.log('\n📈 Top offenders by file:');
	sortedFiles.slice(0, 10).forEach(([file, count], i) => {
		console.log(`  ${i + 1}. ${file}: ${count} findings`);
	});
	
	// Variable name frequency
	const varNameCounts = new Map();
	for (const result of results) {
		varNameCounts.set(result.varName, (varNameCounts.get(result.varName) || 0) + 1);
	}
	
	const sortedVarNames = Array.from(varNameCounts.entries())
		.sort((a, b) => b[1] - a[1]);
	
	console.log('\n📝 Most common single-letter names:');
	sortedVarNames.slice(0, 10).forEach(([varName, count], i) => {
		console.log(`  ${i + 1}. '${varName}': ${count} occurrences`);
	});
	
	console.log('\n═══════════════════════════════════════════════════════════════════');
	console.log(`\n💡 Tip: Run with --verbose to see code context for each finding`);
	console.log(`   Tip: Run with --compact for machine-readable output (file:line:var:context)`);
	console.log(`\nℹ️  Acceptable single-letter names (excluded): ${Array.from(ACCEPTABLE).join(', ')}`);
	console.log(`   Plus 'e' in catch blocks and standard loop patterns\n`);
}

main();
