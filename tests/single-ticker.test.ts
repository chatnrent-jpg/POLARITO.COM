import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { tickerFieldState } from "../src/lib/tickerField";

describe("tickerFieldState", () => {
  it("classifies the single field against the analyzed ticker", () => {
    assert.equal(tickerFieldState("", null), "empty");
    assert.equal(tickerFieldState("   ", "NVDA"), "empty");
    assert.equal(tickerFieldState("12$", "NVDA"), "invalid");
    assert.equal(tickerFieldState("TOOLONGX", null), "invalid");
    assert.equal(tickerFieldState("nvda", "NVDA"), "current");
    assert.equal(tickerFieldState(" NVDA ", "NVDA"), "current");
    assert.equal(tickerFieldState("AAPL", "NVDA"), "pending");
    assert.equal(tickerFieldState("AAPL", null), "pending");
    assert.equal(tickerFieldState("brk.b", "BRK.B"), "current");
  });
});

describe("one Stock Ticker input (source assertions)", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const dash = read("src/components/PolarityDashboard.tsx");
  const ticket = read("src/components/OrderModule.tsx");

  it("the top Analyze input is gone", () => {
    assert.doesNotMatch(dash, /id="ticker"/);
    assert.doesNotMatch(dash, /placeholder="Ticker, e\.g\. NVDA"/);
    assert.doesNotMatch(dash, /<form\b/);
    assert.doesNotMatch(dash, /Analyze a ticker/);
  });

  it("the order box has the only ticker input, editable, with its own Analyze form", () => {
    assert.equal((ticket.match(/id="order-ticker"/g) ?? []).length, 1);
    assert.doesNotMatch(ticket, /readOnly/);
    assert.match(ticket, /ticker\.onAnalyze\(\)/);
    assert.match(ticket, /ticker\.onChange\(e\.target\.value\)/);
    assert.match(ticket, /\{ticker\.loading \? "Loading…" : "Analyze"\}/);
    // the Analyze form is a sibling of the order (review) form, never nested in it
    const analyzeForm = ticket.indexOf("ticker.onAnalyze()");
    const reviewForm = ticket.indexOf("<form onSubmit={onReview}");
    assert.ok(analyzeForm > 0 && reviewForm > analyzeForm);
    const between = ticket.slice(analyzeForm, reviewForm);
    assert.ok(between.includes("</form>"), "analyze form closes before the review form opens");
  });

  it("the dashboard keeps the logic and passes the field down; render stays in the card", () => {
    assert.match(dash, /function analyzeFromField\(\)/);
    assert.match(dash, /saveAnalyzed\(input\.trim\(\)\.toUpperCase\(\)\);\s*void analyze\(input\);/);
    assert.match(dash, /const tickerControl: TickerControl = \{ value: input, onChange: saveDraft, onAnalyze: analyzeFromField, loading \}/);
    assert.match(dash, /<OrderModule key=\{accountId\} analysis=\{analysis\} ticker=\{tickerControl\} \/>/);
    assert.match(dash, /await loadBars\(raw, controller\.signal\)/);
    assert.match(dash, /catch \(err\)/);
    assert.doesNotMatch(ticket, /loadBars|fetch\("\/api\/bars/);
  });

  it("orders only use an analysis that matches the field, and the live watchlist rule is intact", () => {
    assert.match(ticket, /const fieldState = tickerFieldState\(ticker\.value, analyzed\?\.ticker \?\? null\);/);
    assert.match(ticket, /const analysis = fieldState === "current" \? analyzed : null;/);
    assert.match(ticket, /offWatchlist = live && analysis !== null && liveWatchlist\.length > 0 && !liveWatchlist\.includes\(analysis\.ticker\)/);
    assert.match(ticket, /Press Analyze to load/);
  });
});
