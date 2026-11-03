// Build and validate the plugin market index for this repository.
//
//   node tools/market/build-market-index.mjs <indexUrl> [outFile]
//
// <indexUrl> is the absolute URL the index will be published at; relative icon
// references resolve against it. The document is validated with DSH's own
// validator (@deepseek-ai/dsh-plugin-market-index), so anything that passes here
// is accepted by the plugin-market service.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { marketInstallTarget, parseMarketIndex } from "./vendor/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Repository root: the package itself, so the git install spec needs no `path:`. */
export const repoRoot = resolve(here, "..", "..");
const configPath = join(here, "market.config.json");

/** Read one icon file as a base64 data: URL, so the index stays self-contained. */
async function inlineIcon(file) {
	const bytes = await readFile(resolve(here, file));
	return `data:image/svg+xml;base64,${bytes.toString("base64")}`;
}

/** Build the icon reference the format accepts. */
async function iconReference(spec) {
	if (spec === undefined) return undefined;
	if (spec.mode === "inline") return inlineIcon(spec.file);
	if (spec.mode === "relative") return spec.file;
	return spec.url;
}

/**
 * Build the index document from the config.
 * @param {object} options - `indexUrl` and an optional `config` override.
 * @returns {Promise<object>} the document, before validation.
 */
export async function buildDocument(options = {}) {
	const config = options.config ?? JSON.parse(await readFile(configPath, "utf8"));
	const plugin = config.plugin;
	const versions = plugin.versions.map((version) => ({
		version: version.version,
		publishTimestamp: version.publishTimestamp === 0 ? Math.floor(Date.now() / 1000) : version.publishTimestamp,
		source: version.source,
		...(version.engines === undefined ? {} : { engines: version.engines })
	}));
	const icon = await iconReference(plugin.icon);
	return {
		format: 1,
		title: config.index.title,
		...(config.index.description === undefined ? {} : { description: config.index.description }),
		metadata: config.index.metadata,
		plugins: [
			{
				name: plugin.name,
				title: plugin.title,
				description: plugin.description,
				...(plugin.author === undefined ? {} : { author: plugin.author }),
				...(plugin.homepage === undefined ? {} : { homepage: plugin.homepage }),
				...(plugin.repository === undefined ? {} : { repository: plugin.repository }),
				...(icon === undefined ? {} : { icon }),
				metadata: plugin.metadata,
				versions
			}
		]
	};
}

/**
 * Build, validate and write the index.
 * @param {object} options - `indexUrl`, optional `outFile` and `config`.
 * @returns {Promise<{document: object, parsed: object}>} the raw and validated documents.
 */
export async function buildIndex(options = {}) {
	const indexUrl = options.indexUrl ?? "https://example.invalid/market-index.json";
	const outFile = options.outFile ?? join(repoRoot, "market-index.json");
	const document = await buildDocument(options);
	const parsed = parseMarketIndex(document, indexUrl);
	await writeFile(outFile, `${JSON.stringify(document, undefined, 2)}\n`, "utf8");
	return { document, parsed };
}

// CLI: node tools/market/build-market-index.mjs <indexUrl> [outFile]
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const indexUrl = process.argv[2] ?? "https://example.invalid/market-index.json";
	const outFile = process.argv[3];
	const { parsed } = await buildIndex({ indexUrl, outFile });
	console.log(`OK  ${outFile ?? join(repoRoot, "market-index.json")}`);
	console.log(`    index "${parsed.title.en}" — ${parsed.plugins.length} plugin(s)`);
	for (const entry of parsed.plugins) {
		console.log(`    ${entry.name}  versions: ${entry.versions.map((v) => v.version).join(", ")}`);
		for (const version of entry.versions) {
			const target = marketInstallTarget(entry.name, version);
			console.log(`      ${version.version}  spec: ${target.spec}${target.registry === undefined ? "" : `  registry: ${target.registry}`}`);
		}
	}
	console.log(`\nPublish it at: ${indexUrl}`);
}
