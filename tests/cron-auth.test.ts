import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cronAuthorized } from "../src/lib/cronAuth";

const SECRET = "a-long-enough-cron-secret-123";

describe("cronAuthorized", () => {
  it("accepts only the exact bearer secret", () => {
    assert.equal(cronAuthorized(`Bearer ${SECRET}`, SECRET), true);
    assert.equal(cronAuthorized(`Bearer ${SECRET}x`, SECRET), false);
    assert.equal(cronAuthorized(`Bearer wrong-secret-of-same-len!!`, SECRET), false);
    assert.equal(cronAuthorized(SECRET, SECRET), false);
    assert.equal(cronAuthorized(`bearer ${SECRET}`, SECRET), false);
    assert.equal(cronAuthorized(null, SECRET), false);
    assert.equal(cronAuthorized(undefined, SECRET), false);
  });

  it("fails closed when no usable secret is configured", () => {
    assert.equal(cronAuthorized("Bearer ", undefined), false);
    assert.equal(cronAuthorized("Bearer ", ""), false);
    assert.equal(cronAuthorized("Bearer short", "short"), false);
    assert.equal(cronAuthorized("Bearer undefined", undefined), false);
    assert.equal(cronAuthorized(`Bearer ${"x".repeat(15)}`, "x".repeat(15)), false);
  });
});
