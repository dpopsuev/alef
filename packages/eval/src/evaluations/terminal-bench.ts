/**
 * TerminalBench-inspired evaluations for Alef.
 *
 * Five tasks selected from the TerminalBench corpus style:
 *   - Verifiable on any Linux host (bash, python3 available)
 *   - No GPU, no compilation, no multi-machine setup
 *
 * expects: specifies which files the agent must interact with (call + target).
 * checker: terminalScript verifies the output is functionally correct.
 */

import { terminalScript } from "../checkers/terminal.js";
import type { Evaluation } from "../evaluation.js";

const READ_TOOLS = ["fs.read", "lector.read"] as const;
const WRITE_TOOLS = ["fs.write", "fs.edit", "lector.write", "lector.edit"] as const;

export const helloWorld: Evaluation = {
	id: "tb-hello-world",
	toolLevel: "ReadWrite",
	template: "Write",
	prompt:
		"Create a file called `hello.py` in the current directory. " +
		"It should print exactly `Hello, World!` (with exclamation mark) when run with `python3 hello.py`.",
	expects: [{ tool: WRITE_TOOLS, target: { path: "hello.py" } }],
	checker: terminalScript("python3 hello.py | grep -qF 'Hello, World!'"),
	fixture: {
		files: { "hello.py": "print('Hello, World!')\n" },
	},
};

export const wordFrequency: Evaluation = {
	id: "tb-word-frequency",
	toolLevel: "ReadWrite",
	template: "Write",
	seed: [{ path: "input.txt", content: "apple banana apple cherry banana apple cherry cherry\n" }],
	prompt:
		"Read `input.txt`. Count the frequency of each word. " +
		"Write the results to `word_count.txt` in the format `word: count`, " +
		"one entry per line, sorted alphabetically by word.",
	expects: [
		{ tool: READ_TOOLS, target: { path: "input.txt" } },
		{ tool: WRITE_TOOLS, target: { path: "word_count.txt" } },
	],
	checker: terminalScript(`
grep -q "apple: 3" word_count.txt
grep -q "banana: 2" word_count.txt
grep -q "cherry: 3" word_count.txt
`),
	fixture: {
		files: { "word_count.txt": "apple: 3\nbanana: 2\ncherry: 3\n" },
	},
};

export const lineCounter: Evaluation = {
	id: "tb-line-counter",
	toolLevel: "ReadWrite",
	template: "Write",
	seed: [{ path: "data.txt", content: "line one\nline two\nline three\nline four\nline five\n" }],
	prompt:
		"Write a bash script `count_lines.sh` that takes a filename as its first argument " +
		"and prints the number of lines in that file. " +
		"Running `bash count_lines.sh data.txt` must print `5`.",
	expects: [{ tool: WRITE_TOOLS, target: { path: "count_lines.sh" } }],
	checker: terminalScript(`
result=$(bash count_lines.sh data.txt)
[ "$result" = "5" ]
`),
	fixture: {
		files: {
			"count_lines.sh": '#!/bin/bash\nwc -l < "$1"\n',
			"data.txt": "line one\nline two\nline three\nline four\nline five\n",
		},
	},
};

export const jsonConfig: Evaluation = {
	id: "tb-json-config",
	toolLevel: "ReadWrite",
	template: "Write",
	prompt:
		"Create a valid JSON file called `config.json` with these exact fields: " +
		'`host` (string, value "localhost"), `port` (number, value 8080), ' +
		'`debug` (boolean, value false), `tags` (array containing at least "api" and "v1").',
	expects: [{ tool: WRITE_TOOLS, target: { path: "config.json" } }],
	checker: terminalScript(`
python3 -c "
import json, sys
c = json.load(open('config.json'))
assert c['host'] == 'localhost'
assert c['port'] == 8080
assert c['debug'] == False
assert 'api' in c['tags']
assert 'v1' in c['tags']
"
`),
	fixture: {
		files: { "config.json": '{"host":"localhost","port":8080,"debug":false,"tags":["api","v1"]}\n' },
	},
};

export const csvSummary: Evaluation = {
	id: "tb-csv-summary",
	toolLevel: "ReadWrite",
	template: "Write",
	seed: [{ path: "scores.csv", content: "name,score\nAlice,85\nBob,92\nCarol,78\nDan,95\nEve,88\n" }],
	prompt:
		"Read `scores.csv`. Write a Python script `analyze.py` that prints: " +
		"1. `Average: X.XX` (the average score, 2 decimal places). " +
		"2. `Top scorer: NAME` (the person with the highest score).",
	expects: [
		{ tool: READ_TOOLS, target: { path: "scores.csv" } },
		{ tool: WRITE_TOOLS, target: { path: "analyze.py" } },
	],
	checker: terminalScript(`
output=$(python3 analyze.py)
echo "$output" | grep -q "Average: 87.60"
echo "$output" | grep -q "Top scorer: Dan"
`),
	fixture: {
		files: {
			"scores.csv": "name,score\nAlice,85\nBob,92\nCarol,78\nDan,95\nEve,88\n",
			"analyze.py": [
				"import csv",
				"rows = list(csv.DictReader(open('scores.csv')))",
				"scores = [(r['name'], int(r['score'])) for r in rows]",
				"avg = sum(s for _,s in scores) / len(scores)",
				"top = max(scores, key=lambda x: x[1])",
				"print(f'Average: {avg:.2f}')",
				"print(f'Top scorer: {top[0]}')",
			].join("\n"),
		},
	},
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const ALL_TERMINAL_BENCH: readonly Evaluation[] = [
	helloWorld,
	wordFrequency,
	lineCounter,
	jsonConfig,
	csvSummary,
];
