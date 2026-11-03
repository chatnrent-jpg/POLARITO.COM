<?php
/**
 * Polarito secure proxy bridge for Name.com (Apache + PHP).
 *
 * Browser  ->  GET /api/bars?ticker=NVDA   (same origin, no secrets)
 * PHP      ->  Alpaca Market Data + News   (keys from polarito-secrets.php)
 *
 * Mirrors src/lib/marketApi.ts + src/lib/sentimentEngine.ts.
 * Fail closed: missing keys, bad ticker, upstream errors return JSON errors
 * (bars) or Neutral/Apathy 0 (sentiment). Never prints secrets.
 *
 * PHP 7.4+ (select the newest PHP in cPanel → Select PHP Version).
 */
define("POLARITO_BRIDGE", true);

header("Cache-Control: no-store");
header("X-Content-Type-Options: nosniff");
header("Content-Type: application/json; charset=utf-8");

$POLARITO_ORIGINS = array(
    "https://polarito.com",
    "https://www.polarito.com",
    "https://polarito.ai",
    "https://www.polarito.ai",
);

$origin = isset($_SERVER["HTTP_ORIGIN"]) ? $_SERVER["HTTP_ORIGIN"] : "";
if ($origin !== "" && in_array($origin, $POLARITO_ORIGINS, true)) {
    header("Access-Control-Allow-Origin: " . $origin);
    header("Vary: Origin");
    header("Access-Control-Allow-Methods: GET, OPTIONS");
    header("Access-Control-Allow-Headers: Accept");
}

if (isset($_SERVER["REQUEST_METHOD"]) && $_SERVER["REQUEST_METHOD"] === "OPTIONS") {
    http_response_code(204);
    exit;
}

if (!isset($_SERVER["REQUEST_METHOD"]) || $_SERVER["REQUEST_METHOD"] !== "GET") {
    polarito_fail("METHOD", "GET only.", 405);
}

if (!function_exists("curl_init")) {
    polarito_fail("BAD_CONFIG", "PHP cURL is not enabled on this host. Enable it in cPanel → Select PHP Version → Extensions → curl.", 500);
}

$ticker = polarito_ticker(isset($_GET["ticker"]) ? $_GET["ticker"] : "");
if ($ticker === null) {
    polarito_fail("BAD_TICKER", "Enter a valid stock ticker (1-5 letters, e.g. NVDA, TSLA, SPY).", 400);
}

try {
    $secrets = polarito_secrets();
    $feed = $secrets["feed"];
    if ($feed !== "iex" && $feed !== "sip") {
        throw new PolaritoHttp("BAD_CONFIG", "ALPACA_DATA_FEED must be \"iex\" or \"sip\".", 500);
    }
    $bars = polarito_fetch_bars($ticker, $secrets["id"], $secrets["secret"], $feed);
    polarito_validate_bars($bars);
} catch (PolaritoHttp $e) {
    polarito_fail($e->errCode, $e->getMessage(), $e->status);
} catch (Exception $e) {
    error_log("Polarito /api/bars: " . $e->getMessage());
    polarito_fail("INTERNAL", "Unexpected server error.", 500);
}

$sentiment = polarito_sentiment($ticker, $bars, $secrets["id"], $secrets["secret"]);

echo json_encode(array(
    "ok" => true,
    "ticker" => $ticker,
    "bars" => $bars,
    "sentiment" => $sentiment,
));
exit;

/* -------------------------------------------------------------------------- */

class PolaritoHttp extends Exception
{
    public $errCode;
    public $status;
    public function __construct($errCode, $message, $status)
    {
        parent::__construct($message, 0);
        $this->errCode = $errCode;
        $this->status = $status;
    }
}

function polarito_fail($code, $message, $status)
{
    http_response_code((int) $status);
    echo json_encode(array("ok" => false, "code" => $code, "error" => $message));
    exit;
}

function polarito_ticker($raw)
{
    if (!is_string($raw)) {
        return null;
    }
    $t = strtoupper(trim($raw));
    return preg_match('/^[A-Z]{1,5}([.-][A-Z]{1,2})?$/', $t) ? $t : null;
}

function polarito_secrets()
{
    $fromEnvId = getenv("ALPACA_API_KEY_ID");
    $fromEnvSecret = getenv("ALPACA_API_SECRET_KEY");
    $fromEnvFeed = getenv("ALPACA_DATA_FEED");
    if (is_string($fromEnvId) && $fromEnvId !== "" && is_string($fromEnvSecret) && $fromEnvSecret !== "") {
        return array(
            "id" => trim($fromEnvId),
            "secret" => trim($fromEnvSecret),
            "feed" => strtolower(trim(is_string($fromEnvFeed) && $fromEnvFeed !== "" ? $fromEnvFeed : "iex")),
        );
    }

    $candidates = array();
    $dir = __DIR__;
    $candidates[] = dirname($dir, 2) . "/polarito-secrets.php";
    $candidates[] = dirname($dir, 3) . "/polarito-secrets.php";
    $home = getenv("HOME");
    if (is_string($home) && $home !== "") {
        $candidates[] = rtrim($home, "/\\") . "/polarito-secrets.php";
    }

    $cfg = null;
    $seen = array();
    foreach ($candidates as $path) {
        $real = realpath($path);
        $key = $real ? $real : $path;
        if (isset($seen[$key])) {
            continue;
        }
        $seen[$key] = true;
        if (!is_readable($path)) {
            continue;
        }
        $loaded = include $path;
        if (is_array($loaded)) {
            $cfg = $loaded;
            break;
        }
    }

    if (!is_array($cfg)) {
        throw new PolaritoHttp(
            "NO_API_KEY",
            "Alpaca keys are not configured on this host. Place polarito-secrets.php one level above public_html.",
            500
        );
    }

    $id = isset($cfg["ALPACA_API_KEY_ID"]) ? trim((string) $cfg["ALPACA_API_KEY_ID"]) : "";
    $secret = isset($cfg["ALPACA_API_SECRET_KEY"]) ? trim((string) $cfg["ALPACA_API_SECRET_KEY"]) : "";
    $feed = isset($cfg["ALPACA_DATA_FEED"]) ? strtolower(trim((string) $cfg["ALPACA_DATA_FEED"])) : "iex";
    if ($id === "" || $secret === "" || $id === "PASTE_ALPACA_KEY_ID_HERE") {
        throw new PolaritoHttp("NO_API_KEY", "polarito-secrets.php still has placeholder Alpaca keys.", 500);
    }
    return array("id" => $id, "secret" => $secret, "feed" => $feed !== "" ? $feed : "iex");
}

function polarito_curl($url, $keyId, $secret, $timeoutSec)
{
    $ch = curl_init($url);
    curl_setopt_array($ch, array(
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => array(
            "APCA-API-KEY-ID: " . $keyId,
            "APCA-API-SECRET-KEY: " . $secret,
            "Accept: application/json",
        ),
        CURLOPT_TIMEOUT => $timeoutSec,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_FAILONERROR => false,
    ));
    $body = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    if ($body === false) {
        throw new PolaritoHttp("NETWORK", "Could not reach Alpaca (network error or timeout). Try again.", 504);
    }
    return array("status" => $status, "body" => $body, "err" => $err);
}

function polarito_decode($body)
{
    $data = json_decode($body, true);
    if (!is_array($data)) {
        throw new PolaritoHttp("BAD_RESPONSE", "Alpaca returned invalid JSON.", 502);
    }
    return $data;
}

function polarito_map_status($status, $body, $symbol, $feed)
{
    $msg = "";
    $decoded = json_decode($body, true);
    if (is_array($decoded) && isset($decoded["message"]) && is_string($decoded["message"])) {
        $msg = $decoded["message"];
    }
    if ($status === 429) {
        throw new PolaritoHttp("RATE_LIMIT", "Alpaca rate limit reached. Wait a moment and retry.", 429);
    }
    if ($status === 401) {
        throw new PolaritoHttp("AUTH", "Alpaca rejected the API key ID/secret (missing or invalid).", 502);
    }
    if ($status === 403) {
        $detail = $msg !== "" ? ": " . $msg : ".";
        throw new PolaritoHttp("AUTH", "Alpaca denied access to the \"" . $feed . "\" feed" . $detail . " On free plans set ALPACA_DATA_FEED to iex.", 502);
    }
    if ($status === 400 || $status === 422) {
        $detail = $msg !== "" ? ": " . $msg : ".";
        throw new PolaritoHttp("NOT_FOUND", "Alpaca could not process " . $symbol . $detail . " Check the symbol.", 400);
    }
    if ($status < 200 || $status >= 300) {
        throw new PolaritoHttp("UPSTREAM", "Alpaca returned HTTP " . $status . ".", 502);
    }
}

function polarito_iso_day($ts)
{
    $dt = new DateTime($ts);
    return $dt->format("Y-m-d");
}

function polarito_fetch_bars($symbol, $keyId, $secret, $feed)
{
    $end = new DateTime("now", new DateTimeZone("UTC"));
    $start = clone $end;
    $start->modify("-450 days");

    $qs = http_build_query(array(
        "symbols" => $symbol,
        "timeframe" => "1Day",
        "start" => $start->format("Y-m-d"),
        "end" => $end->format("Y-m-d"),
        "adjustment" => "split",
        "feed" => $feed,
        "sort" => "asc",
        "limit" => "10000",
    ));

    $res = polarito_curl("https://data.alpaca.markets/v2/stocks/bars?" . $qs, $keyId, $secret, 10);
    polarito_map_status($res["status"], $res["body"], $symbol, $feed);
    $body = polarito_decode($res["body"]);

    if (!empty($body["next_page_token"])) {
        throw new PolaritoHttp("BAD_RESPONSE", "Alpaca returned a partial page of history; refusing to analyse incomplete data.", 502);
    }

    $raw = null;
    if (isset($body["bars"]) && is_array($body["bars"]) && isset($body["bars"][$symbol]) && is_array($body["bars"][$symbol])) {
        $raw = $body["bars"][$symbol];
    }
    if (!is_array($raw) || count($raw) === 0) {
        throw new PolaritoHttp("NOT_FOUND", "No daily bars returned for " . $symbol . ". Check the symbol.", 404);
    }

    $bars = array();
    foreach ($raw as $i => $r) {
        if (!is_array($r) || !isset($r["t"], $r["o"], $r["h"], $r["l"], $r["c"], $r["v"])) {
            throw new PolaritoHttp("BAD_RESPONSE", "Alpaca bar " . $i . " is malformed.", 502);
        }
        $bars[] = array(
            "date" => polarito_iso_day($r["t"]),
            "open" => (float) $r["o"],
            "high" => (float) $r["h"],
            "low" => (float) $r["l"],
            "close" => (float) $r["c"],
            "volume" => (float) $r["v"],
        );
    }
    return $bars;
}

function polarito_validate_bars($bars)
{
    if (!is_array($bars) || count($bars) === 0) {
        throw new PolaritoHttp("BAD_DATA", "No bars provided.", 502);
    }
    $prev = "";
    foreach ($bars as $i => $b) {
        $where = "Bar " . $i . (isset($b["date"]) ? " (" . $b["date"] . ")" : "");
        if (!isset($b["date"]) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $b["date"])) {
            throw new PolaritoHttp("BAD_DATA", $where . ": date must be YYYY-MM-DD.", 502);
        }
        foreach (array("open", "high", "low", "close", "volume") as $k) {
            if (!isset($b[$k]) || !is_numeric($b[$k]) || !polarito_is_finite((float) $b[$k])) {
                throw new PolaritoHttp("BAD_DATA", $where . ": " . $k . " is not a finite number.", 502);
            }
        }
        if ($b["volume"] < 0) {
            throw new PolaritoHttp("BAD_DATA", $where . ": negative volume.", 502);
        }
        if ($b["low"] <= 0) {
            throw new PolaritoHttp("BAD_DATA", $where . ": non-positive price.", 502);
        }
        if ($b["high"] < $b["low"]) {
            throw new PolaritoHttp("BAD_DATA", $where . ": high < low.", 502);
        }
        if ($b["open"] < $b["low"] || $b["open"] > $b["high"] || $b["close"] < $b["low"] || $b["close"] > $b["high"]) {
            throw new PolaritoHttp("BAD_DATA", $where . ": open/close outside the high-low range.", 502);
        }
        if ($prev !== "" && $b["date"] <= $prev) {
            throw new PolaritoHttp("BAD_DATA", $where . ": bars must be strictly chronological.", 502);
        }
        $prev = $b["date"];
    }
}

function polarito_is_finite($n)
{
    return is_numeric($n) && !is_infinite((float) $n) && !is_nan((float) $n);
}

/* ---------- sentiment (never throws to the client) ---------- */

function polarito_word_forms($base)
{
    $last = substr($base, -1);
    $out = array($base, $base . "s", $base . "es", $base . "d", $base . "ed", $base . "ing");
    if (substr($base, -1) === "e") {
        $out[] = substr($base, 0, -1) . "ing";
    }
    $out[] = $base . $last . "ed";
    $out[] = $base . $last . "ing";
    return $out;
}

function polarito_lookup($words)
{
    $set = array();
    foreach ($words as $w) {
        foreach (polarito_word_forms($w) as $f) {
            $set[$f] = true;
        }
    }
    return $set;
}

function polarito_score_headline($text, $bull, $bear)
{
    $positive = 0;
    $negative = 0;
    if (!is_string($text)) {
        return array($positive, $negative);
    }
    if (!preg_match_all("/[a-z]+/", strtolower($text), $m)) {
        return array($positive, $negative);
    }
    foreach ($m[0] as $word) {
        if (isset($bull[$word])) {
            $positive++;
        } elseif (isset($bear[$word])) {
            $negative++;
        }
    }
    return array($positive, $negative);
}

function polarito_classify($positive, $negative)
{
    $total = $positive + $negative;
    $velocity = $total > 0 ? ($positive - $negative) / $total : 0.0;
    $polarity = 0;
    if ($total >= 2) {
        if ($velocity > 0.2) {
            $polarity = 1;
        } elseif ($velocity < -0.2) {
            $polarity = -1;
        }
    }
    return array("polarity" => $polarity, "velocity" => $velocity);
}

function polarito_eastern_date($iso)
{
    try {
        $dt = new DateTime($iso);
        $dt->setTimezone(new DateTimeZone("America/New_York"));
        return $dt->format("Y-m-d");
    } catch (Exception $e) {
        return null;
    }
}

function polarito_add_days($date, $n)
{
    $dt = DateTime::createFromFormat("Y-m-d", $date, new DateTimeZone("UTC"));
    if (!$dt) {
        return $date;
    }
    $dt->modify(($n >= 0 ? "+" : "") . $n . " days");
    return $dt->format("Y-m-d");
}

function polarito_unavailable($date)
{
    return array(
        "date" => $date,
        "positiveHits" => 0,
        "negativeHits" => 0,
        "articles" => 0,
        "velocity" => 0,
        "polarity" => 0,
        "source" => "unavailable",
    );
}

function polarito_sentiment($symbol, $bars, $keyId, $secret)
{
    $dates = array();
    foreach ($bars as $b) {
        if (isset($b["date"])) {
            $dates[$b["date"]] = true;
        }
    }
    $valid = array_keys($dates);
    sort($valid);
    $fallback = array();
    foreach ($valid as $d) {
        $fallback[] = polarito_unavailable($d);
    }
    if (count($valid) === 0) {
        return $fallback;
    }

    $bull = polarito_lookup(array("surge", "growth", "buy", "bullish", "upgrade", "profit", "shatter", "beat"));
    $bear = polarito_lookup(array("drop", "plunge", "sell", "bearish", "downgrade", "loss", "miss", "risk", "fall"));

    try {
        $startDate = $valid[0];
        $articles = array();
        $seen = array();
        $truncated = false;
        $token = null;
        $deadline = microtime(true) + 20.0;

        for ($page = 0; $page < 10; $page++) {
            if (microtime(true) > $deadline) {
                $truncated = true;
                break;
            }
            $params = array(
                "symbols" => $symbol,
                "start" => polarito_add_days($startDate, -1) . "T00:00:00Z",
                "limit" => "50",
                "sort" => "desc",
                "include_content" => "false",
            );
            if ($token) {
                $params["page_token"] = $token;
            }
            $res = polarito_curl("https://data.alpaca.markets/v1beta1/news?" . http_build_query($params), $keyId, $secret, 8);
            if ($res["status"] === 429) {
                throw new Exception("rate limited (HTTP 429)");
            }
            if ($res["status"] === 401 || $res["status"] === 403) {
                throw new Exception("access denied (HTTP " . $res["status"] . ")");
            }
            if ($res["status"] < 200 || $res["status"] >= 300) {
                throw new Exception("HTTP " . $res["status"]);
            }
            $body = polarito_decode($res["body"]);
            if (!isset($body["news"]) || !is_array($body["news"])) {
                throw new Exception("unexpected payload");
            }
            foreach ($body["news"] as $item) {
                if (!is_array($item) || !isset($item["id"], $item["created_at"], $item["headline"])) {
                    continue;
                }
                $id = (string) $item["id"];
                if (isset($seen[$id])) {
                    continue;
                }
                $seen[$id] = true;
                $articles[] = array(
                    "id" => $id,
                    "createdAt" => (string) $item["created_at"],
                    "headline" => (string) $item["headline"],
                    "symbolCount" => isset($item["symbols"]) && is_array($item["symbols"]) ? count($item["symbols"]) : 1,
                );
            }
            $token = isset($body["next_page_token"]) && is_string($body["next_page_token"]) && $body["next_page_token"] !== ""
                ? $body["next_page_token"]
                : null;
            if ($token === null) {
                $truncated = false;
                break;
            }
            $truncated = true;
        }

        $oldest = null;
        foreach ($articles as $a) {
            $d = polarito_eastern_date($a["createdAt"]);
            if ($d !== null && ($oldest === null || $d < $oldest)) {
                $oldest = $d;
            }
        }
        $coverageStart = ($truncated && $oldest !== null) ? polarito_add_days($oldest, 1) : $valid[0];

        $buckets = array();
        foreach ($articles as $a) {
            if ($a["symbolCount"] > 5) {
                continue;
            }
            $published = polarito_eastern_date($a["createdAt"]);
            if ($published === null || $published < $coverageStart) {
                continue;
            }
            $target = null;
            foreach ($valid as $d) {
                if ($d >= $published) {
                    $target = $d;
                    break;
                }
            }
            if ($target === null) {
                continue;
            }
            $hits = polarito_score_headline($a["headline"], $bull, $bear);
            if (!isset($buckets[$target])) {
                $buckets[$target] = array("positive" => 0, "negative" => 0, "articles" => 0);
            }
            $buckets[$target]["positive"] += $hits[0];
            $buckets[$target]["negative"] += $hits[1];
            $buckets[$target]["articles"] += 1;
        }

        $out = array();
        foreach ($valid as $date) {
            if ($date < $coverageStart) {
                $out[] = polarito_unavailable($date);
                continue;
            }
            $b = isset($buckets[$date]) ? $buckets[$date] : array("positive" => 0, "negative" => 0, "articles" => 0);
            $cls = polarito_classify($b["positive"], $b["negative"]);
            $out[] = array(
                "date" => $date,
                "positiveHits" => $b["positive"],
                "negativeHits" => $b["negative"],
                "articles" => $b["articles"],
                "velocity" => $cls["velocity"],
                "polarity" => $cls["polarity"],
                "source" => "news",
            );
        }
        return $out;
    } catch (Exception $e) {
        error_log("Polarito sentiment unavailable (" . $e->getMessage() . "); defaulting to Apathy (0).");
        return $fallback;
    }
}
