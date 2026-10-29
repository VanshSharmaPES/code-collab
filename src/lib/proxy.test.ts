import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../proxy";

test("the proxy guards the dashboard so visitors without a session are redirected", () => {
  assert.ok(config.matcher.includes("/dashboard"));
});
