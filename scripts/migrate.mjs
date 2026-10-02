#!/usr/bin/env node
import { migrate, rollback } from "./lib/migration.mjs";

const usage = `Controlled first migration (no process killing or implicit HOME paths):
  node scripts/migrate.mjs --agent-dir ABS --release ABS --backup-dir ABS
    --approval ABS --all-instances-stopped [--dry-run]
  node scripts/migrate.mjs --rollback --agent-dir ABS --release ABS --backup-dir ABS
    --journal ABS --all-instances-stopped [--dry-run]

The acknowledgment means ALL related Pi instances completed session_shutdown,
all background/document/other in-flight work ended, and no new instances will
start during this maintenance window. Approval is not a formal deployment order.
`;

function argumentsToOptions(args) {
	const options = {};
	const values = { "--agent-dir": "agentDir", "--release": "release", "--backup-dir": "backupDir", "--approval": "approvalPath", "--journal": "journalPath" };
	const flags = { "--all-instances-stopped": "allInstancesStopped", "--dry-run": "dryRun", "--rollback": "rollback" };
	const seen = new Set();
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (seen.has(arg)) throw new Error(`Duplicate flag: ${arg}`);
		seen.add(arg);
		if (values[arg]) {
			const value = args[++index];
			if (!value || value.startsWith("--")) throw new Error(`Value required for ${arg}`);
			options[values[arg]] = value;
		} else if (flags[arg]) options[flags[arg]] = true;
		else throw new Error(`Unknown option: ${arg}`);
	}
	if (options.rollback && !options.journalPath) throw new Error("Explicit --journal is required for rollback");
	if (!options.rollback && options.journalPath) throw new Error("--journal is only valid with --rollback");
	if (options.rollback && options.approvalPath) throw new Error("Rollback uses its explicit journal, not --approval");
	return options;
}

if (process.argv.slice(2).length === 1 && process.argv[2] === "--help") {
	console.log(usage);
} else {
	try {
		const options = argumentsToOptions(process.argv.slice(2));
		const result = await (options.rollback ? rollback(options) : migrate(options));
		console.log(JSON.stringify(result, null, 2));
	} catch (error) {
		console.error(`Migration refused/failed: ${error.message}\n${usage}`);
		process.exitCode = 1;
	}
}
