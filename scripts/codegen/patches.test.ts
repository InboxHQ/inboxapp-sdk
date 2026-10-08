import { describe, expect, it } from "vitest";
import { applyOperation } from "./patches.ts";

const model = () => ({
  metadata: {},
  shapes: {
    "ns#A": { type: "structure", members: { a: { target: "ns#B" } }, errors: [{ target: "x" }] },
  } as Record<string, any>,
});

describe("patches", () => {
  it("adds, replaces, removes, copies and moves", () => {
    const document = model();

    applyOperation(document, { op: "add", path: "/shapes/ns#A/traits", value: { doc: "hi" } });
    applyOperation(document, {
      op: "replace",
      path: "/shapes/ns#A/members/a/target",
      value: "ns#C",
    });
    applyOperation(document, { op: "add", path: "/shapes/ns#A/errors/-", value: { target: "y" } });
    applyOperation(document, { op: "add", path: "/shapes/ns#A/errors/0", value: { target: "w" } });
    applyOperation(document, { op: "copy", from: "/shapes/ns#A", path: "/shapes/ns#D" });
    applyOperation(document, {
      op: "move",
      from: "/shapes/ns#D/traits",
      path: "/shapes/ns#D/notes",
    });
    applyOperation(document, { op: "remove", path: "/shapes/ns#A/errors/1" });

    expect(document.shapes["ns#A"]).toEqual({
      type: "structure",
      members: { a: { target: "ns#C" } },
      errors: [{ target: "w" }, { target: "y" }],
      traits: { doc: "hi" },
    });
    expect(document.shapes["ns#D"].notes).toEqual({ doc: "hi" });
    expect(document.shapes["ns#D"].traits).toBeUndefined();
  });

  it("fails on a pointer the model no longer has", () => {
    expect(() =>
      applyOperation(model(), { op: "remove", path: "/shapes/ns#Gone/traits/x" }),
    ).toThrow("stale pointer");
    expect(() =>
      applyOperation(model(), { op: "replace", path: "/shapes/ns#A/members/z", value: 1 }),
    ).toThrow("stale pointer");
  });

  it("fails a test op that does not hold, and refuses to patch outside the model", () => {
    expect(() =>
      applyOperation(model(), { op: "test", path: "/shapes/ns#A/type", value: "union" }),
    ).toThrow("test failed");
    expect(() => applyOperation(model(), { op: "add", path: "/paths/~1x", value: {} })).toThrow(
      "/shapes or /metadata",
    );
  });
});
