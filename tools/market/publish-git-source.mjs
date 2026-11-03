// Publish this plugin to a Git remote and refresh the market index that points at it.
//
//   node tools/market/publish-git-source.mjs --repo <https-repo-url> [options]
//
// Options:
//   --repo <url>        REQUIRED. The canonical https URL of the repository, e.g.
//                       https://github.com/<user>/dsh-plugin-session-delete
//                       This URL is what the index records; it must also be reachable.
//   --remote <url>      Git remote to push to. Defaults to --repo (https).
//                       Use an ssh URL when you authenticate by key:
//                       --remote git@github.com:<user>/dsh-plugin-session-delete.git
//   --branch <name>     Branch to publish. Default: main
//   --index-url <url>   Where the index will be served. Default: the raw URL of
//                       market-index.json on GitHub for --repo/--branch.
//   --message <text>    Commit message for the plugin snapshot. Default: generated.
//   --dry-run           Do everything except push.
//
// What it does, and why two commits:
//   1. commit A = the plugin code. Its SHA is what users install.
//   2. the index is regenerated with commit A pinned, then committed as commit B.
//      The index therefore always points at a commit that exists in the repository.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildIndex, repoRoot } from "./build-market-index.mjs";

/** Parse `--key value` arguments. */
function parseArgs(argv) {
	const args = {};
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (!token.startsWith("--")) continue;
		const key = token.slice(2);
		const next = argv[index + 1];
		if (next === undefined || next.startsWith("--")) {
			args[key] = true;
		} else {
			args[key] = next;
			index++;
		}
	}
	return args;
}

/**
 * Run a git command. Standard streams are inherited, so git talks to the user's
 * terminal directly (and no piped capture is needed).
 * @param {string[]} parts - git arguments.
 * @returns {number} the exit status.
 */
function git(...parts) {
	const result = spawnSync("git", parts, { cwd: repoRoot, stdio: "inherit" });
	return result.status ?? 1;
}

/**
 * Read the current commit SHA straight from the repository's refs, so the script
 * never has to capture a child's output.
 * @returns {string} the 40-hex commit SHA.
 */
function headSha() {
	const head = readFileSync(join(repoRoot, ".git", "HEAD"), "utf8").trim();
	if (!head.startsWith("ref: ")) return head;
	const ref = head.slice("ref: ".length).trim();
	const loose = join(repoRoot, ".git", ref);
	if (existsSync(loose)) return readFileSync(loose, "utf8").trim();
	const packed = readFileSync(join(repoRoot, ".git", "packed-refs"), "utf8");
	const line = packed.split("\n").find((candidate) => candidate.endsWith(` ${ref}`));
	if (line === undefined) throw new Error(`cannot resolve ${ref}`);
	return line.split(" ")[0];
}

const args = parseArgs(process.argv.slice(2));
const repo = args.repo;
if (typeof repo !== "string" || repo === "") {
	console.error("usage: node tools/market/publish-git-source.mjs --repo <https-repo-url> [--remote <git-url>] [--branch main] [--index-url <url>] [--dry-run]");
	process.exit(2);
}
const branch = typeof args.branch === "string" ? args.branch : "main";
const remote = typeof args.remote === "string" ? args.remote : repo;
const configPath = join(repoRoot, "tools", "market", "market.config.json");

// Derive the raw URL of the published index when the caller did not name one.
let indexUrl = args.indexUrl;
if (typeof indexUrl !== "string") {
	const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(repo);
	if (match === null) {
		console.error("--index-url is required for a non-GitHub repository (it is where market-index.json will be served).");
		process.exit(2);
	}
	indexUrl = `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${branch}/market-index.json`;
}

// 1. Make sure the repository exists and the branch is checked out.
if (!existsSync(join(repoRoot, ".git"))) git("init", "-b", branch);
git("checkout", "-B", branch);

// 2. Commit A: the plugin snapshot users will install.
git("add", "--all");
const message = typeof args.message === "string" ? args.message : "chore: publish dsh-plugin-session-delete";
git("commit", "-m", message);
const commit = headSha();
console.log(`plugin commit: ${commit}`);

// 3. Point the index at that commit and regenerate it.
const config = JSON.parse(await readFile(configPath, "utf8"));
for (const version of config.plugin.versions) {
	version.source = { type: "git", url: repo, commit };
}
// Keep the displayed links pointing at the repository actually published.
config.plugin.repository = { ...config.plugin.repository, url: repo };
config.plugin.homepage = repo;
await writeFile(configPath, `${JSON.stringify(config, undefined, 2)}\n`, "utf8");
const { parsed } = await buildIndex({ indexUrl });
console.log(`index written and validated: ${parsed.plugins.length} plugin(s)`);
for (const entry of parsed.plugins) {
	for (const version of entry.versions) {
		console.log(`  ${entry.name}@${version.version} -> ${version.source.commit.slice(0, 10)}`);
	}
}

// 4. Commit B: the refreshed index.
git("add", "--all");
git("commit", "-m", "docs: refresh plugin market index");

// 5. Push both commits.
if (args["dry-run"] === true) {
	console.log("\n--dry-run: not pushing.");
} else {
	const hasOrigin = git("remote", "get-url", "origin") === 0;
	if (hasOrigin) git("remote", "set-url", "origin", remote);
	else git("remote", "add", "origin", remote);
	const pushStatus = git("push", "-u", "origin", branch);
	if (pushStatus !== 0) {
		console.error(`\npush FAILED (git exit ${pushStatus}). Nothing reached ${remote}; fix the remote or the credentials and re-run this script.`);
		process.exit(pushStatus);
	}
	console.log(`\npushed to ${remote} (${branch})`);
}

console.log(`
Users install it like this:
  1. Plugins -> More -> Experimental plugins -> enable "Custom plugin markets"
  2. Discover tab -> add this index source:
       ${indexUrl}
  3. search "session" -> install "Session Delete"
`);
