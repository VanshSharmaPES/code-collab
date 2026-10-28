// The sentence-transformer used for similarity search. Shared by the embedding script (P2-17) and the search page
// (P2-18); both must use the same model, because vectors from different models cannot be compared.
export const MODEL_NAME = "Xenova/all-MiniLM-L6-v2"; // runs locally through ONNX; no API and no key
export const DIMENSIONS = 384;

// A list of text in, one normalised vector per text out.
export type Embedder = (texts: string[]) => Promise<number[][]>;

// pgvector's text form of a vector. Every number is checked, so nothing but numbers can end up in the literal.
export function toVectorLiteral(vector: readonly number[]): string {
  if (vector.length !== DIMENSIONS) throw new RangeError(`An embedding must have ${DIMENSIONS} numbers, got ${vector.length}.`);
  for (const x of vector) if (typeof x !== "number" || !Number.isFinite(x)) throw new TypeError("An embedding may only contain finite numbers.");
  return `[${vector.join(",")}]`;
}
