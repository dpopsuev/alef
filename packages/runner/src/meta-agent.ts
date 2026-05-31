/**
 * Meta-agent — in-process Alef sub-agent with access to Alef's own APIs.
 *
 * Phase 1: nodesh organ with a prelude that exposes SessionStore, config,
 * organs, and PM history. The meta-agent answers natural-language queries
 * about the running Alef instance. ALE-TSK-384 / ALE-SPC-50.
 *
 * Phase 2 (TODO): replace nodesh prelude with a typed alef-api organ.
 * Phase 3 (TODO): stream reply through parent ChatWriter, support :resume.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { Agent } from "@dpopsuev/alef-corpus";
import { DialogOrgan } from "@dpopsuev/alef-organ-dialog";
import { Cerebrum } from "@dpopsuev/alef-organ-llm";
import { createNodeshOrgan } from "@dpopsuev/alef-organ-nodesh";
import { DEFAULT_MODEL } from "./args.js";
import { buildModel } from "./model.js";

// Prelude injected into every nodesh.eval context.
// Exposes Alef internals via synchronous require() calls.
const ALEF_API_PRELUDE = `
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const homedir = os.homedir();

// List all session IDs across all cwd hashes.
function listAllSessions() {
  const root = path.join(homedir, '.alef', 'sessions');
  if (!fs.existsSync(root)) return [];
  const sessions = [];
  for (const cwdHash of fs.readdirSync(root)) {
    const dir = path.join(root, cwdHash);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.replace('.jsonl', '');
      const p = path.join(dir, f);
      try {
        const stat = fs.statSync(p);
        const lines = fs.readFileSync(p, 'utf-8').split('\\n').filter(Boolean);
        let firstMsg = '';
        for (const line of lines) {
          try {
            const r = JSON.parse(line);
            if (r.bus === 'sense' && r.type === 'dialog.message') {
              firstMsg = (r.payload?.text || '').slice(0, 80);
              break;
            }
          } catch { break; }
        }
        sessions.push({ id, cwdHash, mtime: stat.mtime.toISOString(), firstMsg, turns: lines.length });
      } catch {}
    }
  }
  return sessions.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

// Read a session's first N turns.
function readSession(id, maxTurns = 5) {
  const root = path.join(homedir, '.alef', 'sessions');
  for (const cwdHash of fs.readdirSync(root)) {
    const p = path.join(root, cwdHash, id + '.jsonl');
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf-8').split('\\n').filter(Boolean);
    const turns = [];
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        if (r.type === 'dialog.message') turns.push(r.payload?.text || r.payload?.conversationHistory);
        if (turns.length >= maxTurns) break;
      } catch {}
    }
    return turns;
  }
  return null;
}

// Expose for meta-agent use.
const alef = { listAllSessions, readSession, homedir };
`;

export async function runMetaAgent(prompt: string, modelId?: string): Promise<string> {
	const model = modelId ? buildModel(modelId) : buildModel(DEFAULT_MODEL);

	const agent = new Agent();
	let reply = "(no reply)";

	const dialog = new DialogOrgan({
		sink: (text) => {
			if (text) reply = text;
		},
		getTools: () => agent.tools,
		systemPrompt:
			"You are an Alef meta-agent. You have access to nodesh.eval which can query Alef session history, config, and organs. Always use alef.listAllSessions() to discover sessions. Respond concisely.",
	});

	const nodesh = createNodeshOrgan({
		cwd: join(homedir(), ".alef"),
		prelude: ALEF_API_PRELUDE,
		extraAllowedModules: ["node:fs", "node:os", "node:path"],
	});

	const llm = new Cerebrum({ model, timeoutMs: 60_000 });

	agent.load(dialog).load(nodesh).load(llm);
	await agent.ready();

	await dialog.send(prompt, "human", 60_000);
	agent.dispose();
	return reply;
}
