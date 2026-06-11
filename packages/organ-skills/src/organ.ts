/**
 * SkillsOrgan — the Skill Library.
 *
 * A single creature that owns the aggregated skill registry and exposes it
 * to the LLM. Two sources are merged at runtime:
 *
 *   1. Organ-registered SkillBooks — declared via organ.skills[]; delivered
 *      via sense/organ.loaded announcements emitted by the Agent runtime.
 *      Handlers are idempotent: re-announcing an organ replaces its books.
 *
 *   2. Filesystem SKILL.md files — user-written skills discovered from
 *      standard paths (agentskills.io convention) at construction time.
 *
 * Tools:
 *   skills.books   — list all books with name, description, page count
 *   skills.list    — list all filesystem skills (backward compat)
 *   skills.invoke  — load a skill by name, or a specific page from a book
 *   skills.open    — load all pages from a book into context at once
 */

import type {
	MotorHandlerCtx,
	Organ,
	OrganContributions,
	OrganLogger,
	SkillBook,
	SkillPage,
} from "@dpopsuev/alef-kernel";
import { defineOrgan, getString, typedAction } from "@dpopsuev/alef-kernel";
import { z } from "zod";
import { discoverSkills, skillsToXml } from "./discovery.js";
import type { Skill } from "./types.js";

export interface SkillsOrganOptions {
	/** Working directory for relative skill path resolution. */
	cwd: string;
	/** Additional filesystem skill directories beyond the standard paths. */
	skillsPaths?: string[];
	logger?: OrganLogger;
}

const BOOKS_TOOL = {
	name: "skills.books",
	description: "List all skill library books with name, description, and page count.",
	inputSchema: z.object({}),
};

const LIST_TOOL = {
	name: "skills.list",
	description: "List all discovered SKILL.md skills with their names and descriptions.",
	inputSchema: z.object({}),
};

const INVOKE_TOOL = {
	name: "skills.invoke",
	description:
		"Load skill instructions into context. " +
		"Pass name to load a filesystem skill. " +
		"Pass book + page to load one page from a library book.",
	inputSchema: z.object({
		name: z.string().optional().describe("Filesystem skill name as shown in skills.list"),
		book: z.string().optional().describe("Library book name as shown in skills.books"),
		page: z.string().optional().describe("Page name within the book"),
	}),
};

const OPEN_TOOL = {
	name: "skills.open",
	description: "Load all pages from a skill library book into context at once.",
	inputSchema: z.object({
		book: z.string().min(1).describe("Book name as shown in skills.books"),
	}),
};

export function createSkillsOrgan(opts: SkillsOrganOptions): Organ {
	const library = new Map<string, SkillBook>();
	const organBooks = new Map<string, SkillBook[]>();

	function rebuildLibrary(): void {
		library.clear();
		for (const contribution of organBooks.values()) {
			for (const book of contribution) {
				const existing = library.get(book.name);
				library.set(book.name, existing ? { ...existing, pages: [...existing.pages, ...book.pages] } : book);
			}
		}
	}

	function mergeBooks(organName: string, books: readonly SkillBook[]): void {
		organBooks.set(organName, [...books]);
		rebuildLibrary();
	}

	function removeOrgan(organName: string): void {
		if (!organBooks.has(organName)) return;
		organBooks.delete(organName);
		rebuildLibrary();
	}

	const skills: Skill[] = discoverSkills(opts.cwd, opts.skillsPaths ?? []);
	const byName = new Map(skills.map((s) => [s.name, s]));

	function buildDirective(): string {
		const libraryIndex =
			library.size > 0
				? `**Skill Library books** — call skills.open({ book }) to load all pages:\n` +
					[...library.values()]
						.map((b) => `- **${b.name}** — ${b.description} (${b.pages.length} page(s))`)
						.join("\n")
				: "";
		const skillsIndex = skillsToXml(skills)
			? `**Available skills (from SKILL.md discovery)**\n\nCall skills.invoke with the skill name to load instructions when relevant.\n\n${skillsToXml(skills)}`
			: "";
		return (
			[libraryIndex, skillsIndex].filter(Boolean).join("\n\n") ||
			"Use skills.books to list library books and skills.list to list filesystem skills."
		);
	}

	function handleBooks(): Record<string, unknown> {
		const books = [...library.values()].map((b) => ({
			name: b.name,
			description: b.description,
			pageCount: b.pages.length,
			pages: b.pages.map((p: SkillPage) => ({ name: p.name, description: p.description })),
		}));
		return { books, total: books.length };
	}

	function handleList(): Record<string, unknown> {
		return {
			skills: skills.map((s) => ({
				name: s.name,
				description: s.description,
				userInvocable: s.userInvocable,
				disableModelInvocation: s.disableModelInvocation,
				path: s.path,
			})),
			total: skills.length,
		};
	}

	function handleInvoke(ctx: MotorHandlerCtx): Record<string, unknown> {
		const bookName = getString(ctx.payload, "book");
		const pageName = getString(ctx.payload, "page");
		const skillName = getString(ctx.payload, "name");

		if (bookName) {
			const book = library.get(bookName);
			if (!book)
				throw new Error(
					`skills.invoke: book "${bookName}" not found. Available: ${[...library.keys()].join(", ") || "(none)"}`,
				);
			if (!pageName)
				throw new Error(`skills.invoke: pass page name to load a specific page from book "${bookName}"`);
			const page = book.pages.find((p: SkillPage) => p.name === pageName);
			if (!page)
				throw new Error(
					`skills.invoke: page "${pageName}" not found in book "${bookName}". Pages: ${book.pages.map((p: SkillPage) => p.name).join(", ")}`,
				);
			return { book: bookName, page: pageName, instructions: page.instructions };
		}

		if (skillName) {
			const skill = byName.get(skillName);
			if (!skill)
				throw new Error(
					`skills.invoke: skill "${skillName}" not found. Available: ${[...byName.keys()].join(", ") || "(none)"}`,
				);
			if (!skill.userInvocable) throw new Error(`skills.invoke: skill "${skillName}" is not user-invocable.`);
			return { name: skill.name, instructions: skill.instructions, path: skill.path };
		}

		throw new Error("skills.invoke: pass name (filesystem skill) or book + page (library)");
	}

	function handleOpen(ctx: MotorHandlerCtx): Record<string, unknown> {
		const bookName = getString(ctx.payload, "book") ?? "";
		const book = library.get(bookName);
		if (!book)
			throw new Error(
				`skills.open: book "${bookName}" not found. Available: ${[...library.keys()].join(", ") || "(none)"}`,
			);
		const instructions = book.pages.map((p: SkillPage) => `## ${p.name}\n\n${p.instructions}`).join("\n\n---\n\n");
		return { book: bookName, pageCount: book.pages.length, instructions };
	}

	const agentRunContribution: import("@dpopsuev/alef-kernel").AgentRunContribution = {
		schema: {
			playbook: z
				.string()
				.optional()
				.describe("Named skill library playbook to load as the subagent's system prompt base."),
		},
		extend(args, context) {
			const playbook = typeof args.playbook === "string" ? args.playbook : undefined;
			if (!playbook) return;
			const book = library.get(playbook);
			if (!book) return;
			context.prependInstructions(
				book.pages.map((p: SkillPage) => `## ${p.name}\n\n${p.instructions}`).join("\n\n---\n\n"),
			);
		},
	};

	return defineOrgan(
		"skills",
		{
			sense: {
				"organ.loaded": {
					handle: async (ctx) => {
						const name = getString(ctx.payload, "name") ?? "";
						const books = (ctx.payload.contributions as OrganContributions | undefined)?.skills ?? [];
						if (books.length > 0) mergeBooks(name, books);
					},
				},
				"organ.unloaded": {
					handle: async (ctx) => {
						const name = getString(ctx.payload, "name") ?? "";
						removeOrgan(name);
					},
				},
			},
			motor: {
				"skills.books": typedAction(BOOKS_TOOL, async () => handleBooks()),
				"skills.list": typedAction(LIST_TOOL, async () => handleList()),
				"skills.invoke": typedAction(INVOKE_TOOL, async (ctx) => handleInvoke(ctx as unknown as MotorHandlerCtx)),
				"skills.open": typedAction(OPEN_TOOL, async (ctx) => handleOpen(ctx as unknown as MotorHandlerCtx)),
			},
		},
		{
			logger: opts.logger,
			directives: [buildDirective()],
			contributions: { "agent.run": agentRunContribution },
			description: `Skill Library: filesystem skills discovered at boot, organ books registered dynamically via organ.loaded events.`,
			labels: ["skills", "library", "context", "instructions"],
		},
	);
}
