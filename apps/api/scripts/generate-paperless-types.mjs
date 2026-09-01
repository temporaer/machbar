#!/usr/bin/env node
// Regenerates src/paperless/schema.d.ts from openapi/paperless.yaml.
//
// This runs entirely offline against the committed schema file — it never
// contacts a Paperless instance — so both the schema and the generated types
// are checked in and kept in sync deterministically. Run this after editing
// openapi/paperless.yaml:
//
//   npm run generate:paperless-types -w @machbar/api
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import openapiTS, { astToString } from "openapi-typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const schemaPath = path.join(root, "openapi", "paperless.yaml");
const outPath = path.join(root, "src", "paperless", "schema.d.ts");

const ast = await openapiTS(new URL(`file://${schemaPath}`));
const output = astToString(ast);

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, output, "utf8");

console.log(`Generated ${path.relative(root, outPath)} from ${path.relative(root, schemaPath)}.`);
