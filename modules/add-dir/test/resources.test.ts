import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CONTEXT_FILE_LIMIT,
	CONTEXT_TOTAL_LIMIT,
	buildContextInjection,
	collectSkillPaths,
	contextSummary,
	scanDirContext,
} from "../src/resources.ts";

async function temporary(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-add-dir-resources-"));
	t.after(async () => {
		await rm(directory, { recursive: true, force: true });
	});
	return directory;
}

test("reads root and .pi instruction files and discovers declared skill roots", async (t) => {
	const root = await temporary(t);
	await writeFile(join(root, "AGENTS.md"), "root agents\n");
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(join(root, ".pi/AGENTS.md"), "pi agents\n");
	await writeFile(join(root, "CLAUDE.md"), "root claude\n");
	await writeFile(join(root, ".pi/CLAUDE.md"), "pi claude\n");
	for (const [relative, name] of [[".pi/skills/one", "one"], [".agents/skills/two", "two"], [".claude/skills/three", "three"]]) {
		await mkdir(join(root, relative), { recursive: true });
		await writeFile(join(root, relative, "SKILL.md"), `# ${name}\n`);
	}
	await mkdir(join(root, ".pi/skills/empty"), { recursive: true });
	const context = scanDirContext(root);
	assert.equal(context.agentsMd, "root agents\n\n\npi agents\n");
	assert.equal(context.claudeMd, "root claude\n\n\npi claude\n");
	assert.equal(context.skills.size, 3);
	assert.match(contextSummary(context), /AGENTS\.md, CLAUDE\.md, 3 skill\(s\)/);
	const injection = buildContextInjection([{ absolutePath: root, label: "root" }]);
	for (const marker of ["root agents", "pi agents", "root claude", "pi claude"]) {
		assert.ok(injection.text.includes(marker), `all four instruction locations are injected: ${marker}`);
	}
});

test("ignores instruction paths that are not regular files", async (t) => {
	const root = await temporary(t);
	await mkdir(join(root, "AGENTS.md"), { recursive: true });
	assert.equal(scanDirContext(root).agentsMd, null);
});

test("deduplicates discovered skills by canonical file path", async (t) => {
	const first = await temporary(t);
	const second = await temporary(t);
	for (const root of [first, second]) {
		await mkdir(join(root, ".pi/skills/shared"), { recursive: true });
		await writeFile(join(root, ".pi/skills/shared/SKILL.md"), "# shared\n");
	}
	const paths = collectSkillPaths([
		{ absolutePath: first, label: "first" },
		{ absolutePath: first, label: "duplicate" },
		{ absolutePath: second, label: "second" },
	]);
	assert.equal(paths.length, 2, "distinct files stay distinct candidates while repeated scans collapse");
	assert.equal(new Set(paths).size, paths.length);
});

test("reports instruction limits as documented and reads acceptable files whole", async (t) => {
	assert.equal(CONTEXT_FILE_LIMIT, 65_536);
	assert.equal(CONTEXT_TOTAL_LIMIT, 131_072);
	const root = await temporary(t);
	const accepted = `${"b".repeat(65_536 - "END-OF-ACCEPTED-BODY".length)}END-OF-ACCEPTED-BODY`;
	assert.equal(Buffer.byteLength(accepted, "utf8"), 65_536, "the accepted fixture sits exactly on the file limit");
	await writeFile(join(root, "AGENTS.md"), accepted);
	const injection = buildContextInjection([{ absolutePath: root, label: "root" }]);
	assert.ok(injection.text.includes(accepted), "a file at the limit is injected whole, never truncated");
	assert.equal(injection.skipped.length, 0);
	await writeFile(join(root, "AGENTS.md"), `${accepted}x`);
	const oversized = buildContextInjection([{ absolutePath: root, label: "root" }]);
	assert.ok(!oversized.text.includes("END-OF-ACCEPTED-BODY"), "one byte over the limit is skipped whole");
	assert.equal(oversized.skipped.length, 1);
	assert.match(oversized.skipped[0] ?? "", /AGENTS\.md/);
	assert.equal(buildContextInjection([]).text, "");
});

test("accounts for the file budget in bytes rather than characters", async (t) => {
	const root = await temporary(t);
	const multibyte = "é".repeat(32_768);
	assert.equal(Buffer.byteLength(multibyte, "utf8"), 65_536);
	await writeFile(join(root, "AGENTS.md"), multibyte);
	assert.ok(buildContextInjection([{ absolutePath: root, label: "root" }]).text.includes(multibyte));
	await writeFile(join(root, "AGENTS.md"), `${multibyte}é`);
	const oversized = buildContextInjection([{ absolutePath: root, label: "root" }]);
	assert.ok(!oversized.text.includes(multibyte));
	assert.equal(oversized.skipped.length, 1);
});

test("skips malformed UTF-8 and diagnoses it without losing readable instructions", async (t) => {
	const root = await temporary(t);
	await writeFile(join(root, "AGENTS.md"), "readable instructions\n");
	await writeFile(join(root, "CLAUDE.md"), Buffer.from([0x41, 0xff, 0xfe, 0x42]));
	const injection = buildContextInjection([{ absolutePath: root, label: "root" }]);
	assert.match(injection.text, /readable instructions/);
	assert.equal(injection.skipped.length, 1);
	assert.match(injection.skipped[0] ?? "", /CLAUDE\.md/);
});

test("diagnoses an unreadable instruction path without losing the readable ones", async (t) => {
	const root = await temporary(t);
	await writeFile(join(root, "AGENTS.md"), "surviving instructions\n");
	await symlink("CLAUDE.md", join(root, "CLAUDE.md"));
	const injection = buildContextInjection([{ absolutePath: root, label: "root" }]);
	assert.match(injection.text, /surviving instructions/);
	assert.equal(injection.skipped.length, 1);
	assert.match(injection.skipped[0] ?? "", /CLAUDE\.md/);
});

test("reports the instructions hidden when the budget runs out at a heading", async (t) => {
	const root = await temporary(t);
	const first = join(root, "first");
	const longName = "l".repeat(120);
	const second = join(root, longName);
	await mkdir(first);
	await mkdir(second);
	await writeFile(join(first, "AGENTS.md"), "x".repeat(65536));
	await writeFile(join(first, "CLAUDE.md"), "x".repeat(65000));
	await writeFile(join(second, "AGENTS.md"), "# second\n");
	const injection = buildContextInjection([
		{ absolutePath: first, label: "first" },
		{ absolutePath: second, label: longName },
	]);
	assert.ok(!injection.text.includes(`### ${longName}`), "the second heading is what no longer fits");
	assert.ok(
		injection.skipped.some((entry) => entry.startsWith(join(second, "AGENTS.md"))),
		"the instructions hidden by the exhausted budget are reported",
	);
});

for (const failure of ["oversized", "malformed UTF-8", "symlink loop"] as const) {
	test(`reports ${failure} instructions behind an over-budget heading`, async (t) => {
		const root = await temporary(t);
		const first = join(root, "first");
		const secondName = "l".repeat(200);
		const thirdName = "m".repeat(200);
		const second = join(root, secondName);
		const third = join(root, thirdName);
		for (const directory of [first, second, third]) await mkdir(directory);
		await writeFile(join(first, "AGENTS.md"), "x".repeat(65_536));
		await writeFile(join(first, "CLAUDE.md"), "x".repeat(65_000));
		await writeFile(join(second, "AGENTS.md"), "second rules");
		const failedPath = join(second, "CLAUDE.md");
		if (failure === "symlink loop") await symlink("CLAUDE.md", failedPath);
		else await writeFile(failedPath, failure === "oversized" ? Buffer.alloc(65_537, 0x61) : Buffer.from([0xff, 0xfe]));
		await writeFile(join(third, "AGENTS.md"), "third rules");
		const injection = buildContextInjection([
			{ absolutePath: first, label: "first" },
			{ absolutePath: second, label: secondName },
			{ absolutePath: third, label: thirdName },
		]);
		assert.ok(!injection.text.includes(`### ${secondName}`), "the second heading does not fit");
		assert.ok(!injection.text.includes(`### ${thirdName}`), "the third heading does not fit either");
		assert.ok(Buffer.byteLength(injection.text) <= 131_072);
		assert.equal(injection.skipped.length, 3, "one diagnostic per real file, none for absent .pi files");
		assert.equal(
			injection.skipped[0],
			`${join(second, "AGENTS.md")}: exceeds the 131072-byte external instruction budget`,
		);
		assert.ok(injection.skipped[1]?.startsWith(`${failedPath}: `), "a failed read has its own diagnostic");
		assert.ok(!injection.skipped[1]?.includes("external instruction budget"), "a read failure is not misreported as budget exhaustion");
		assert.equal(
			injection.skipped[2],
			`${join(third, "AGENTS.md")}: exceeds the 131072-byte external instruction budget`,
			"reporting continues to the later directory",
		);
	});
}

test("never exceeds the total instruction budget", async (t) => {
	const root = await temporary(t);
	await writeFile(join(root, "AGENTS.md"), Buffer.alloc(65_536, 0x61));
	await writeFile(join(root, "CLAUDE.md"), Buffer.alloc(65_536, 0x62));
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(join(root, ".pi/CLAUDE.md"), Buffer.alloc(65_536, 0x63));
	const injection = buildContextInjection([{ absolutePath: root, label: "root" }]);
	assert.ok(Buffer.byteLength(injection.text, "utf8") <= 131_072);
	assert.ok(injection.skipped.length >= 1, "files beyond the budget are diagnosed, not truncated silently");
});
