import assert from "node:assert/strict";
import { test } from "node:test";
import { DIMENSIONS, MODEL_NAME, toVectorLiteral } from "./embedding-model";

const vector = (n = DIMENSIONS, v = 0.5) => Array.from({ length: n }, () => v);

test("a vector becomes pgvector's text form: [a,b,c,...]", () => {
  const literal = toVectorLiteral(vector(DIMENSIONS, 0.25));
  assert.match(literal, /^\[(0\.25,){383}0\.25\]$/);
  assert.equal(MODEL_NAME, "Xenova/all-MiniLM-L6-v2");
  assert.equal(DIMENSIONS, 384);
});

test("a vector with the wrong length, or anything but finite numbers, is refused before it reaches the database", () => {
  for (const n of [0, 1, 383, 385, 768]) assert.throws(() => toVectorLiteral(vector(n)), RangeError, String(n));
  for (const bad of [NaN, Infinity, -Infinity]) assert.throws(() => toVectorLiteral([...vector(383), bad]), TypeError, String(bad));
  for (const bad of ["1); DROP TABLE embeddings; --", null, undefined, {}, [1]]) {
    assert.throws(() => toVectorLiteral([...vector(383), bad as unknown as number]), TypeError, JSON.stringify(bad));
  }
});
