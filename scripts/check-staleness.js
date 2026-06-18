#!/usr/bin/env node

/**
 * File Staleness Diagnostic Script
 * 
 * Analyzes .ts files in packages/*/src to identify stale files that were
 * written once and never touched again.
 * 
 * Output format: filepath:commitCount:daysSinceLastChange:firstCommitDate
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Configuration
const FILE_PATTERN = 'packages/*/src/**/*.ts';
const STALE_COMMIT_THRESHOLD = 2; // Files with 1-2 commits
const STALE_AGE_DAYS = 30; // Older than 30 days

/**
 * Execute a shell command and return output
 */
function exec(command, options = {}) {
  try {
    return execSync(command, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options
    }).trim();
  } catch (error) {
    if (options.ignoreError) {
      return '';
    }
    throw error;
  }
}

/**
 * Find all .ts files matching the pattern
 */
function findTypeScriptFiles() {
  const output = exec(`find packages/*/src -type f -name "*.ts" 2>/dev/null || true`, { ignoreError: true });
  
  if (!output) {
    return [];
  }
  
  return output.split('\n').filter(Boolean);
}

/**
 * Get commit count for a file
 */
function getCommitCount(filepath) {
  try {
    const output = exec(`git log --oneline -- "${filepath}" | wc -l`);
    return parseInt(output, 10) || 0;
  } catch (error) {
    return 0;
  }
}

/**
 * Get the date of the last commit for a file
 */
function getLastCommitDate(filepath) {
  try {
    const output = exec(`git log -1 --format=%ct -- "${filepath}"`);
    if (!output) return null;
    return new Date(parseInt(output, 10) * 1000);
  } catch (error) {
    return null;
  }
}

/**
 * Get the date of the first commit for a file
 */
function getFirstCommitDate(filepath) {
  try {
    const output = exec(`git log --reverse --format=%ct -- "${filepath}" | head -1`);
    if (!output) return null;
    return new Date(parseInt(output, 10) * 1000);
  } catch (error) {
    return null;
  }
}

/**
 * Calculate days between two dates
 */
function daysBetween(date1, date2) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((date2 - date1) / msPerDay);
}

/**
 * Analyze a single file for staleness
 */
function analyzeFile(filepath) {
  const commitCount = getCommitCount(filepath);
  
  // Skip files with no commits (shouldn't happen in git repo)
  if (commitCount === 0) {
    return null;
  }
  
  const lastCommitDate = getLastCommitDate(filepath);
  const firstCommitDate = getFirstCommitDate(filepath);
  
  if (!lastCommitDate || !firstCommitDate) {
    return null;
  }
  
  const now = new Date();
  const daysSinceLastChange = daysBetween(lastCommitDate, now);
  
  return {
    filepath,
    commitCount,
    daysSinceLastChange,
    firstCommitDate: firstCommitDate.toISOString().split('T')[0],
    lastCommitDate: lastCommitDate.toISOString().split('T')[0],
    isStale: commitCount <= STALE_COMMIT_THRESHOLD && daysSinceLastChange > STALE_AGE_DAYS
  };
}

/**
 * Format analysis result as output string
 */
function formatResult(result) {
  return `${result.filepath}:${result.commitCount}:${result.daysSinceLastChange}:${result.firstCommitDate}`;
}

/**
 * Main execution
 */
function main() {
  console.log('=== File Staleness Analysis ===\n');
  console.log(`Searching for TypeScript files in packages/*/src...\n`);
  
  const files = findTypeScriptFiles();
  
  if (files.length === 0) {
    console.log('No TypeScript files found.');
    return;
  }
  
  console.log(`Found ${files.length} TypeScript files. Analyzing...\n`);
  
  const results = [];
  const staleFiles = [];
  
  for (const file of files) {
    const analysis = analyzeFile(file);
    if (analysis) {
      results.push(analysis);
      if (analysis.isStale) {
        staleFiles.push(analysis);
      }
    }
  }
  
  // Sort stale files by commit count (ascending) then by age (descending)
  staleFiles.sort((a, b) => {
    if (a.commitCount !== b.commitCount) {
      return a.commitCount - b.commitCount;
    }
    return b.daysSinceLastChange - a.daysSinceLastChange;
  });
  
  // Output stale files
  console.log(`\n=== STALE FILES (${staleFiles.length}) ===`);
  console.log(`(Criteria: <= ${STALE_COMMIT_THRESHOLD} commits AND > ${STALE_AGE_DAYS} days old)\n`);
  console.log('Format: filepath:commitCount:daysSinceLastChange:firstCommitDate\n');
  
  if (staleFiles.length > 0) {
    staleFiles.forEach(result => {
      console.log(formatResult(result));
    });
  } else {
    console.log('No stale files found!');
  }
  
  // Summary statistics
  console.log('\n=== SUMMARY ===');
  console.log(`Total files analyzed: ${results.length}`);
  console.log(`Stale files: ${staleFiles.length} (${((staleFiles.length / results.length) * 100).toFixed(1)}%)`);
  
  const avgCommits = results.reduce((sum, r) => sum + r.commitCount, 0) / results.length;
  const avgAge = results.reduce((sum, r) => sum + r.daysSinceLastChange, 0) / results.length;
  
  console.log(`Average commits per file: ${avgCommits.toFixed(1)}`);
  console.log(`Average age (days): ${avgAge.toFixed(1)}`);
  
  // Files with only 1 commit
  const singleCommitFiles = results.filter(r => r.commitCount === 1);
  if (singleCommitFiles.length > 0) {
    console.log(`\nFiles with exactly 1 commit: ${singleCommitFiles.length}`);
    const staleSingleCommit = singleCommitFiles.filter(r => r.daysSinceLastChange > STALE_AGE_DAYS);
    console.log(`  - Of which are stale (> ${STALE_AGE_DAYS} days): ${staleSingleCommit.length}`);
  }
  
  // Additional insights
  const veryOldFiles = results.filter(r => r.daysSinceLastChange > 365);
  if (veryOldFiles.length > 0) {
    console.log(`\nFiles untouched for > 1 year: ${veryOldFiles.length}`);
  }
  
  console.log('\n=== END ===');
}

// Run the script
if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

module.exports = { analyzeFile, getCommitCount, getLastCommitDate, getFirstCommitDate };
