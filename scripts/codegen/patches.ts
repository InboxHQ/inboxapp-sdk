import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "./model.ts";

export interface PatchOperation {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  from?: string;
  value?: unknown;
}

export interface PatchFile {
  description: string;
  patches: PatchOperation[];
}

/** Applies every `*.patch.json` in name order. A pointer that no longer resolves fails the run. */
export function applyPatchFiles(model: Model, directory: string): string[] {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".patch.json"))
    .sort();
  for (const file of files) {
    const patch: PatchFile = JSON.parse(readFileSync(join(directory, file), "utf8"));
    if (!patch.description) throw new Error(`${file}: a patch file needs a description`);
    patch.patches.forEach((operation, index) => {
      try {
        applyOperation(model, operation);
      } catch (cause) {
        throw new Error(`${file} #${index} (${operation.op} ${operation.path}): ${String(cause)}`);
      }
    });
  }
  return files;
}

export function applyOperation(document: unknown, operation: PatchOperation): void {
  if (!operation.path.startsWith("/shapes/") && !operation.path.startsWith("/metadata/")) {
    throw new Error("patches target /shapes or /metadata of the converted model");
  }
  switch (operation.op) {
    case "add":
      return add(document, operation.path, structuredClone(operation.value));
    case "remove":
      return void remove(document, operation.path);
    case "replace":
      remove(document, operation.path);
      return add(document, operation.path, structuredClone(operation.value));
    case "move":
      return add(document, operation.path, remove(document, required(operation.from)));
    case "copy":
      return add(
        document,
        operation.path,
        structuredClone(get(document, required(operation.from))),
      );
    case "test":
      if (JSON.stringify(get(document, operation.path)) !== JSON.stringify(operation.value)) {
        throw new Error("test failed");
      }
      return;
    default:
      throw new Error(`unknown op ${JSON.stringify(operation.op)}`);
  }
}

const required = (from: string | undefined): string => {
  if (from === undefined) throw new Error("missing from");
  return from;
};

const tokens = (pointer: string): string[] =>
  pointer
    .split("/")
    .slice(1)
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));

function parentOf(document: unknown, pointer: string): [any, string] {
  const path = tokens(pointer);
  const last = path.pop();
  if (last === undefined) throw new Error("the document root cannot be patched");
  let current: any = document;
  for (const token of path) {
    if (current === null || typeof current !== "object" || !(token in current)) {
      throw new Error(`stale pointer: nothing at "${token}"`);
    }
    current = current[token];
  }
  if (current === null || typeof current !== "object") throw new Error("stale pointer");
  return [current, last];
}

function get(document: unknown, pointer: string): unknown {
  const [parent, key] = parentOf(document, pointer);
  if (!(key in parent)) throw new Error(`stale pointer: nothing at "${key}"`);
  return parent[key];
}

function add(document: unknown, pointer: string, value: unknown): void {
  const [parent, key] = parentOf(document, pointer);
  if (!Array.isArray(parent)) {
    parent[key] = value;
    return;
  }
  const index = key === "-" ? parent.length : Number(key);
  if (!Number.isInteger(index) || index < 0 || index > parent.length) {
    throw new Error(`stale pointer: index ${key} is out of bounds`);
  }
  parent.splice(index, 0, value);
}

function remove(document: unknown, pointer: string): unknown {
  const [parent, key] = parentOf(document, pointer);
  if (!(key in parent)) throw new Error(`stale pointer: nothing at "${key}"`);
  if (Array.isArray(parent)) return parent.splice(Number(key), 1)[0];
  const value = parent[key];
  delete parent[key];
  return value;
}
