#!/usr/bin/env bun
/**
 * convert: the OpenAPI document becomes a Smithy 2.0 JSON model.
 *
 * Input:  spec/openapi.json, patches/*.patch.json (RFC 6902, on the converted model)
 * Output: .generated-specs/inboxapp.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildModel, MODEL_PATH, serialize } from "./codegen/pipeline.ts";

const root = resolve(import.meta.dirname, "..");
const { model, patches } = buildModel(root);

mkdirSync(dirname(join(root, MODEL_PATH)), { recursive: true });
writeFileSync(join(root, MODEL_PATH), serialize(model));

const count = (type: string) =>
  Object.values(model.shapes).filter((shape) => shape.type === type).length;
console.log(
  `convert: ${count("service")} services, ${count("operation")} operations, ` +
    `${Object.keys(model.shapes).length} shapes, ${patches.length} patch files`,
);
