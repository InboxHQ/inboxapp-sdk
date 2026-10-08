import {
  reachable,
  Trait,
  type Model,
  type OperationShape,
  type ServiceShape,
  type Shape,
} from "./model.ts";

const FINALIZED = "inboxapp.finalized";

/** Runs once on a freshly converted, patched model: opens response enums, drops orphans, checks targets. */
export function finalize(model: Model): Model {
  if (model.metadata[FINALIZED]) throw new Error("The model is already finalized; re-run convert");

  const services = shapesOf<ServiceShape>(model, "service");
  const operations = services.flatMap(([, service]) =>
    service.operations.map((operation) => {
      const shape = model.shapes[operation.target];
      if (shape?.type !== "operation") throw new Error(`Not an operation: ${operation.target}`);
      return shape as OperationShape;
    }),
  );
  const events = Object.entries(model.shapes)
    .filter(([, shape]) => shape.traits?.[Trait.webhookEvent] !== undefined)
    .map(([id]) => id);
  const errors = [
    ...services.flatMap(([, service]) => service.errors ?? []),
    ...operations.flatMap((operation) => operation.errors ?? []),
  ].map((error) => error.target);

  const outputs = reachable(model, [
    ...operations.map((operation) => operation.output.target),
    ...errors,
    ...events,
  ]);
  for (const id of outputs) {
    const shape = model.shapes[id]!;
    if (shape.type !== "enum" || Object.keys(shape.members).length < 2) continue;
    const traits = (shape.traits ??= {});
    if (!(Trait.open in traits)) traits[Trait.open] = true;
  }

  const inputs = reachable(
    model,
    operations.map((operation) => operation.input.target),
  );
  const kept = new Set([...outputs, ...inputs]);
  const shapes: Record<string, Shape> = {};
  for (const [id, shape] of Object.entries(model.shapes)) {
    if (shape.type === "service" || shape.type === "operation" || kept.has(id)) shapes[id] = shape;
  }

  return { ...model, metadata: { ...model.metadata, [FINALIZED]: true }, shapes };
}

function shapesOf<S extends Shape>(model: Model, type: S["type"]): Array<[string, S]> {
  return Object.entries(model.shapes).filter(([, shape]) => shape.type === type) as Array<
    [string, S]
  >;
}
