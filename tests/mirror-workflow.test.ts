import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const wf = readFileSync(new URL("../.github/workflows/mirror-run.yml", import.meta.url), "utf8");
const script = wf.split("        run: |\n")[1] ?? "";

describe("mirror-run workflow keeps curl failures visible", () => {
  it("never discards curl's stderr or forces a failed exit to http=000", () => {
    assert.doesNotMatch(script, /2>\s*\/dev\/null\)\s*\|\|\s*code=000/);
    assert.match(script, /2>"\$ERRF"/);
    assert.match(script, /curl_exit=\$rc/);
    assert.match(script, /curl_error=\[/);
  });

  it("logs timing for every call and has a connect timeout", () => {
    assert.match(script, /%\{time_namelookup\}/);
    assert.match(script, /%\{time_appconnect\}/);
    assert.match(script, /%\{time_total\}/);
    assert.match(script, /--connect-timeout/);
  });

  it("cleans the base URL variable and requires a bare https host", () => {
    assert.match(script, /tr -d '\[:space:\]/);
    assert.match(script, /\^https:\/\/\[A-Za-z0-9\.-\]\+/);
  });

  it("preflights without the secret and expects 401 before looping", () => {
    const pre = script.indexOf("Preflight");
    const loop = script.indexOf("while in_window");
    assert.ok(pre > -1 && loop > pre);
    const preflightBlock = script.slice(pre, loop);
    assert.doesNotMatch(preflightBlock, /Authorization/);
  });

  it("never echoes the secret", () => {
    assert.doesNotMatch(script, /echo[^\n]*\$POLARITO_CRON_SECRET/);
    assert.doesNotMatch(script, /set -x/);
  });

  it("keeps the concurrency group, 5.5h hand-off and under-6h job timeout", () => {
    assert.match(wf, /group: mirror-run/);
    assert.match(wf, /cancel-in-progress: false/);
    assert.match(script, /MAX_SECONDS=19800/);
    assert.match(wf, /timeout-minutes: 345/);
    assert.match(wf, /workflow_dispatch/);
  });
});
