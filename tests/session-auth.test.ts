import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  authIsConfigured,
  createSessionToken,
  safeEqual,
  verifyPassword,
  verifySessionToken,
} from "../src/lib/sessionAuth";

const ENV_KEYS = [
  "POLARITO_AUTH_USER",
  "POLARITO_AUTH_PASSWORD",
  "POLARITO_AUTH_SECRET",
] as const;

const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

describe("sessionAuth", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("fails closed when env is missing", () => {
    assert.equal(authIsConfigured(), false);
    assert.equal(verifyPassword("anyone", "anything"), false);
    assert.equal(createSessionToken("anyone"), null);
    assert.equal(verifySessionToken("not.a.token"), null);
  });

  it("rejects a short signing secret", () => {
    process.env.POLARITO_AUTH_USER = "ops";
    process.env.POLARITO_AUTH_PASSWORD = "correct-horse";
    process.env.POLARITO_AUTH_SECRET = "too-short";
    assert.equal(authIsConfigured(), false);
  });

  it("accepts matching credentials and issues a verifiable token", () => {
    process.env.POLARITO_AUTH_USER = "ops";
    process.env.POLARITO_AUTH_PASSWORD = "correct-horse-battery";
    process.env.POLARITO_AUTH_SECRET = "0123456789abcdef0123456789abcdef";

    assert.equal(authIsConfigured(), true);
    assert.equal(verifyPassword("ops", "correct-horse-battery"), true);
    assert.equal(verifyPassword("ops", "wrong"), false);
    assert.equal(verifyPassword("other", "correct-horse-battery"), false);

    const token = createSessionToken("ops", 1_700_000_000);
    assert.ok(token);
    assert.equal(verifySessionToken(token, 1_700_000_000), "ops");
    assert.equal(verifySessionToken(token, 1_700_000_000 + 60 * 60 * 24 * 8), null);
  });

  it("rejects a tampered token", () => {
    process.env.POLARITO_AUTH_USER = "ops";
    process.env.POLARITO_AUTH_PASSWORD = "correct-horse-battery";
    process.env.POLARITO_AUTH_SECRET = "0123456789abcdef0123456789abcdef";

    const token = createSessionToken("ops", 1_700_000_000)!;
    const [body] = token.split(".");
    assert.equal(verifySessionToken(`${body}.deadbeef`), null);
  });

  it("safeEqual is length-sensitive", () => {
    assert.equal(safeEqual("abc", "abc"), true);
    assert.equal(safeEqual("abc", "abd"), false);
    assert.equal(safeEqual("abc", "ab"), false);
  });
});
