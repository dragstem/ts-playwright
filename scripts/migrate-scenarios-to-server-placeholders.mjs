import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const AdmZip = require("../apps/server/node_modules/adm-zip");

const rootDir = path.resolve(process.cwd(), "storage", "projects");
const packagePaths = findPackagePaths(rootDir);

let changedPackages = 0;

for (const packagePath of packagePaths) {
  const zip = new AdmZip(packagePath);
  const metadataEntry = zip.getEntry("metadata.json");
  const scenarioEntry = zip.getEntry("scenario.spec.ts");
  if (!metadataEntry || !scenarioEntry) {
    continue;
  }

  const metadata = JSON.parse(metadataEntry.getData().toString("utf8"));
  const source = scenarioEntry.getData().toString("utf8");

  const nextSource = migrateScenarioSource(source);
  const nextMetadata = migrateScenarioMetadata(metadata);

  const sourceChanged = nextSource !== source;
  const metadataChanged = JSON.stringify(nextMetadata) !== JSON.stringify(metadata);

  if (!sourceChanged && !metadataChanged) {
    continue;
  }

  zip.updateFile("scenario.spec.ts", Buffer.from(nextSource, "utf8"));
  zip.updateFile("metadata.json", Buffer.from(`${JSON.stringify(nextMetadata, null, 2)}\n`, "utf8"));
  zip.writeZip(packagePath);
  changedPackages += 1;
  process.stdout.write(`${path.relative(process.cwd(), packagePath)}\n`);
}

process.stdout.write(`Updated packages: ${changedPackages}\n`);

function findPackagePaths(startDir) {
  if (!fs.existsSync(startDir)) {
    return [];
  }

  const results = [];
  walk(startDir, results);
  return results.sort((left, right) => left.localeCompare(right));
}

function walk(currentDir, results) {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const target = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walk(target, results);
      continue;
    }
    if (entry.isFile() && entry.name === "package.zip") {
      results.push(target);
    }
  }
}

function migrateScenarioSource(source) {
  let next = source;

  next = next.replace(
    /(getByRole\('textbox', \{ name: 'Username' \}\)\.fill\()'[^']*'(\))/g,
    "$1'{server_username}'$2"
  );
  next = next.replace(
    /(getByRole\('textbox', \{ name: 'Password' \}\)\.fill\()'[^']*'(\))/g,
    "$1'{server_password}'$2"
  );
  next = next.replace(
    /(getByRole\('option', \{ name: )'maugry \(MAU\)'( \}\)\.click\(\);)/g,
    "$1'{server_merchant}'$2"
  );
  next = next.replaceAll("{{INPUT:2fa_otp}}", "{server_2faotp}");
  next = next.replaceAll("{{INPUT:merchant}}", "{server_merchant}");

  return next;
}

function migrateScenarioMetadata(metadata) {
  const nextInputs = Array.isArray(metadata.inputs)
    ? metadata.inputs.filter((input) => input?.name !== "2fa_otp" && input?.name !== "merchant")
    : [];

  return {
    ...metadata,
    inputs: nextInputs
  };
}
