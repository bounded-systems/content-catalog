#!/usr/bin/env node
// Discovers all opted-in repos in the org via .string-audit.json sentinel,
// fetches their catalogs at HEAD, namespaces keys by repo name, merges, and writes:
//
//   catalog.merged.json   — namespaced catalog loadable by string-audit's loadCatalog()
//   grounding.merged.json — grounding terms KEYED BY REPO: { "<repo>": ["term", …], … }
//
// Provenance is embedded as $provenance in catalog.merged.json (loadCatalog skips $
// keys, so the gate consumes the file unmodified). SLSA attestation is applied to
// catalog.merged.json by the workflow via actions/attest-build-provenance.
//
// grounding.merged.json is a CONTRACT WITH bounded-systems/string-audit: aggregate.yml
// runs `.string-audit/audit-gate.mjs` with GROUNDING pointing at it. The gate accepts a
// flat array (a single repo auditing itself) OR this per-repo map, and grounds a claim
// `<repo>.<key>` only against `<repo>`'s terms — so the workflow's `ref:` pin must be at a
// string-audit release that understands the map before this file changes shape.
//
// It used to be a flat union of every repo's terms, which meant any repo's vocabulary
// grounded every other repo's claims (#14): `brand` contributes bare nouns ("agent",
// "door", "process"), so "Our agent is provably unbreakable." passed the honesty gate
// backed by nothing. Keyed by repo, a claim can only draw on facts its own repo declared.
//
// Sentinel format (.string-audit.json in each participating repo root):
//   { "catalogPath": "dist/catalog.json", "groundingPath": "dist/grounding.json" }
// Both paths are optional (defaults shown above). groundingPath may be omitted — but if it
// IS declared it must resolve to a JSON array of non-empty strings, or this run fails.
// Declaring a path that 404s, or that holds an object, used to be silently ignored, which
// is indistinguishable from declaring nothing while quietly disabling the honesty check
// for that repo (site#189 hit exactly this).
//
// Env: GITHUB_TOKEN (required), ORG (default: bounded-systems)

import { writeFileSync } from "node:fs";

const token = process.env.GITHUB_TOKEN;
if (!token) { console.error("aggregate: GITHUB_TOKEN env var required"); process.exit(1); }

const org = process.env.ORG ?? "bounded-systems";

async function gh(path) {
  const r = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      Accept: "application/vnd.github+json",
    },
  });
  if (r.status === 404) return null;
  if (!r.ok) { console.warn(`  gh api ${path} → HTTP ${r.status}`); return null; }
  return r.json();
}

async function fileText(repo, filePath) {
  const d = await gh(`repos/${org}/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`);
  if (!d?.content) return null;
  return Buffer.from(d.content, "base64").toString("utf8");
}

// Paginate all repos in the org
const repos = [];
for (let page = 1; ; page++) {
  const batch = await gh(`orgs/${org}/repos?per_page=100&page=${page}&sort=full_name`);
  if (!batch?.length) break;
  repos.push(...batch);
  if (batch.length < 100) break;
}
console.log(`\n  ${org}: ${repos.length} repos\n`);

const merged = {};
const groundingByRepo = {};
const sources = {};
let noCatalog = 0; // opted-in but catalog path not yet populated

// A repo that declares groundingPath and then hands us something unusable is a
// misconfiguration that SILENTLY WEAKENS the honesty gate, so it must never pass quietly.
// Collected rather than thrown so one run names every broken sentinel — fixing them one
// nightly at a time is its own kind of slow failure.
const groundingErrors = [];

for (const { name: repo, default_branch } of repos) {
  const raw = await fileText(repo, ".string-audit.json");
  if (!raw) continue; // not opted in

  let config;
  try { config = JSON.parse(raw); }
  catch { console.warn(`  ${repo}: invalid .string-audit.json — skipping`); continue; }

  const catalogPath = config.catalogPath ?? "dist/catalog.json";
  const catalogText = await fileText(repo, catalogPath);
  if (!catalogText) { noCatalog++; continue; } // opted-in but catalog not yet added

  let catalog;
  try { catalog = JSON.parse(catalogText); }
  catch { console.warn(`  ${repo}: catalog parse error — skipping`); continue; }

  // record the commit SHA for provenance
  const head = await gh(`repos/${org}/${repo}/commits/${default_branch}`);
  const sha = head?.sha ?? "unknown";

  let count = 0;
  for (const [k, v] of Object.entries(catalog)) {
    if (k.startsWith("$") || !v || typeof v !== "object") continue;
    merged[`${repo}.${k}`] = { ...v, $source: repo };
    count++;
  }

  if (config.groundingPath) {
    const where = `${repo}:${config.groundingPath}`;
    const groundingText = await fileText(repo, config.groundingPath);
    if (!groundingText) {
      groundingErrors.push(`${where} — declared in .string-audit.json but the file is missing or empty`);
    } else {
      let terms;
      try { terms = JSON.parse(groundingText); }
      catch (e) { groundingErrors.push(`${where} — not valid JSON (${e.message})`); }

      if (terms !== undefined) {
        const shape = Array.isArray(terms) ? "array" : terms === null ? "null" : typeof terms;
        if (shape !== "array") {
          // The trap site#189 fell into: content/grounding.json is an OBJECT keyed by
          // phrase, so declaring the authoring source parses fine, misses Array.isArray,
          // and grounds nothing — the same symptom as declaring no path at all.
          groundingErrors.push(
            `${where} — expected a JSON array of terms, got ${shape}` +
            (shape === "object" ? " (an object keyed by phrase? declare the emitted array instead)" : "")
          );
        } else {
          const bad = terms.filter((t) => typeof t !== "string" || !t.trim());
          if (bad.length) {
            groundingErrors.push(`${where} — ${bad.length} entr${bad.length === 1 ? "y is" : "ies are"} not a non-empty string`);
          } else {
            // Namespaced by repo: these terms ground THIS repo's claims and no other's.
            groundingByRepo[repo] = terms.map((t) => t.trim());
            if (!terms.length) console.warn(`  ! ${repo}: grounding file is an empty array — every claim in ${repo} will fail the gate`);
          }
        }
      }
    }
  }

  const groundingCount = groundingByRepo[repo]?.length;
  sources[repo] = { sha, branch: default_branch, catalogPath, symbols: count };
  if (groundingCount !== undefined) sources[repo].groundingPath = config.groundingPath;
  console.log(
    `  ✓ ${repo.padEnd(28)} ${count} symbols @ ${sha.slice(0, 8)}` +
    (groundingCount !== undefined ? ` · ${groundingCount} grounding term(s)` : "")
  );
}

// Fail closed on a broken grounding declaration. Silently skipping one disables the
// honesty check for that repo while the run stays green and the catalog still gets
// committed AND attested — the same failure shape as #10's narrowed enumeration.
if (groundingErrors.length) {
  console.error(`\n  ✗ ${groundingErrors.length} unusable grounding declaration(s):`);
  for (const e of groundingErrors) console.error(`      ${e}`);
  console.error(
    "\n  A declared groundingPath must resolve to a JSON array of non-empty strings.\n" +
    "  Fix the path or the file, or drop groundingPath from that repo's .string-audit.json.\n"
  );
  process.exit(1);
}

const total = Object.keys(merged).length;
if (!total) {
  console.error("\n  no symbols — add a content catalog to at least one opted-in repo");
  process.exit(1);
}

if (noCatalog) console.log(`  (${noCatalog} opted-in repo${noCatalog !== 1 ? "s" : ""} have no catalog yet — add content/strings.json when ready)`);

// Embed provenance as $-prefixed metadata (loadCatalog in string-audit skips these)
merged["$provenance"] = {
  org,
  generated: new Date().toISOString(),
  sources,
};

writeFileSync("catalog.merged.json", JSON.stringify(merged, null, 2));
// Keyed by repo, sorted for a stable diff — the gate resolves `<repo>.<key>` back to its
// own terms, so no repo's vocabulary can ground another repo's claims (#14).
const groundingSorted = Object.fromEntries(Object.keys(groundingByRepo).sort().map((r) => [r, groundingByRepo[r]]));
writeFileSync("grounding.merged.json", JSON.stringify(groundingSorted, null, 2));

const sourceCount = Object.keys(sources).length;
const groundingRepos = Object.keys(groundingByRepo).length;
// $provenance is metadata, not a symbol — exclude it, as loadCatalog does.
const ungrounded = Object.keys(merged).filter((k) => !k.startsWith("$") && !groundingByRepo[merged[k].$source]).length;
console.log(`\n  merged: ${total} symbols from ${sourceCount} repo${sourceCount !== 1 ? "s" : ""}`);
console.log(`  grounding: ${groundingRepos} repo${groundingRepos !== 1 ? "s" : ""} declare terms · ${ungrounded} symbol(s) from repos with none`);
console.log(`  wrote: catalog.merged.json · grounding.merged.json\n`);
