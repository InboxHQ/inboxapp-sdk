import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finalize } from "./finalize.ts";
import type { Model } from "./model.ts";
import { convertOpenApi } from "./openapi.ts";
import { applyPatchFiles } from "./patches.ts";

export const SPEC_PATH = "spec/openapi.json";
export const MODEL_PATH = ".generated-specs/inboxapp.json";

/** spec → Smithy model → patches → finalize. The result is what `MODEL_PATH` holds. */
export function buildModel(root: string): { model: Model; patches: string[] } {
  const document = JSON.parse(readFileSync(join(root, SPEC_PATH), "utf8"));
  if (typeof document.openapi !== "string" || document.paths === undefined) {
    throw new Error(`${SPEC_PATH} is not an OpenAPI document`);
  }

  const converted = convertOpenApi(document, {
    retryableStatuses: {
      429: { throttling: true },
      500: {},
      502: {},
      503: {},
      504: {},
    },
  });
  const patches = applyPatchFiles(converted, join(root, "patches"));
  return { model: finalize(converted), patches };
}

export const serialize = (model: Model) => `${JSON.stringify(model, null, 2)}\n`;
