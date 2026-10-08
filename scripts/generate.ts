#!/usr/bin/env bun
/**
 * generate: the Smithy model becomes both clients, in one run.
 *
 * Input:  .generated-specs/inboxapp.json (written by scripts/convert.ts)
 * Output: src/services         the default client (types, operations, errors, resources)
 *         src/effect/services  the Effect client (schemas, tagged errors, operations)
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { emitClient } from "./codegen/emit-client.ts";
import { emitEffect } from "./codegen/emit-effect.ts";
import { format } from "./codegen/format.ts";
import type { Model } from "./codegen/model.ts";
import { MODEL_PATH } from "./codegen/pipeline.ts";
import { analyze } from "./codegen/sdk.ts";

const root = resolve(import.meta.dirname, "..");
const model: Model = JSON.parse(readFileSync(join(root, MODEL_PATH), "utf8"));
const sdk = analyze(model);

const outputs = [
  { directory: "src/services", files: emitClient(sdk) },
  { directory: "src/effect/services", files: emitEffect(sdk) },
];
for (const { directory, files } of outputs) {
  rmSync(join(root, directory), { recursive: true, force: true });
  for (const [file, content] of files) {
    const path = join(root, directory, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}
format(
  root,
  outputs.map((output) => output.directory),
);

console.log(
  `generate: ${sdk.services.length} services, ${sdk.operations.length} operations, ` +
    `${sdk.errors.length} error codes, ${sdk.events.length} webhook events`,
);
