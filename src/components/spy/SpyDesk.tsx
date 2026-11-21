"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import SpyDeskView, { type AutoUi, type CloseUi, type DeskLoad, type Notice, type TicketUi } from "@/components/spy/SpyDeskView";
import { ANALYZE_PATH, DESK_PATH, LIVE_PATH, browserPollerEnv, getJson } from "@/lib/spyDeskClient";
import { createAnalyzer, sidePermit } from "@/lib/spyAnalyzer";
import { createDeskData } from "@/lib/spyDeskData";

const IDLE_CLOSE: CloseUi = { stage: "idle", ack: false, offerUnpriced: false };
const IDLE_AUTO: AutoUi = { ack: false };
const FIRST_TICKET: TicketUi = { type: "call", symbol: null, ack: false };

type ApiAnswer = { ok: boolean; code?: string; error?: string; message?: string };

async function readAnswer(res: Response): Promise<ApiAnswer> {
  try {
    const data = (await res.json()) as unknown;
    if (typeof data === "object" && data !== null && typeof (data as { ok?: unknown }).ok === "boolean") return data as ApiAnswer;
  } catch {
    /* falls through */
  }
  return { ok: false, error: `The server answered ${res.status} with something unreadable.` };
}

/**
 * Container: owns the small UI state (what the user chose or ticked) and hands plain data to the pure view.
 * The data itself comes from the data layer (spyDeskData.ts), which polls with GET only: the light view every 5 s, the option
 * chain every 45 s or on demand. A refresh replaces the data only. The user's choices (Call/Put, chosen contract, ticked boxes,
 * an open Close box, notices) are kept in this component's own state, which no refresh touches, and a refresh never submits.
 * During a user action the refresh is held, and right after it both views are re-read from the server.
 */
export default function SpyDesk() {
  const [data] = useState(() =>
    createDeskData({
      env: browserPollerEnv(),
      fetchLive: (signal) => getJson(LIVE_PATH, signal),
      fetchDesk: (signal) => getJson(DESK_PATH, signal),
    }),
  );
  const desk = useSyncExternalStore(data.subscribe, data.getState, data.getState);
  const [analyzerCore] = useState(() => createAnalyzer({ env: browserPollerEnv(), fetchAnalysis: (signal) => getJson(ANALYZE_PATH, signal) }));
  const analyzer = useSyncExternalStore(analyzerCore.subscribe, analyzerCore.getState, analyzerCore.getState);
  const liveAction = desk.snapshot?.decision.action ?? "UNKNOWN";
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [ticket, setTicket] = useState<TicketUi>(FIRST_TICKET);
  const [close, setClose] = useState<CloseUi>(IDLE_CLOSE);
  const [autoUi, setAutoUi] = useState<AutoUi>(IDLE_AUTO);
  const alive = useRef(true);

  // A Close box left open for a position that is gone (Auto closed it, or a new one opened) must not carry over to the next one.
  const position = desk.snapshot?.position;
  const positionKey = position === undefined ? "none" : position.status === "held" ? `held:${position.symbol}` : position.status;
  const [seenPosition, setSeenPosition] = useState(positionKey);
  if (seenPosition !== positionKey) {
    setSeenPosition(positionKey);
    setClose(IDLE_CLOSE);
  }

  // The gear is watched on every 5 s refresh: when it moves, the analyzer loads it again and the ticket is re-checked.
  useEffect(() => {
    analyzerCore.observe(liveAction);
  }, [analyzerCore, liveAction]);

  // A ticked acknowledgement belongs to the gear it was ticked under: when the gear changes it is cleared (the rest is kept).
  const gearKey = analyzer.analysis?.gear ?? "none";
  const [seenGear, setSeenGear] = useState(gearKey);
  if (seenGear !== gearKey) {
    setSeenGear(gearKey);
    setTicket((t) => (t.ack ? { ...t, ack: false } : t));
  }

  useEffect(() => {
    alive.current = true;
    data.start();
    return () => {
      alive.current = false;
      data.stop();
    };
  }, [data]);

  const refresh = useCallback(() => {
    setNotice(null);
    data.refreshNow("both");
  }, [data]);

  const post = useCallback(async (path: string, body: unknown): Promise<ApiAnswer> => {
    try {
      const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
      return await readAnswer(res);
    } catch {
      return { ok: false, error: "Could not reach the server. Nothing was changed; check the state shown." };
    }
  }, []);

  /** One user action: hold the refresh, send it, show the answer, then re-read the server's own data (never assume what happened). */
  const act = useCallback(
    async (path: string, body: unknown, after: (a: ApiAnswer) => void): Promise<void> => {
      const release = data.hold();
      setBusy(true);
      setNotice(null);
      try {
        const a = await post(path, body);
        if (alive.current) after(a);
      } finally {
        release();
        if (alive.current) setBusy(false);
      }
    },
    [data, post],
  );

  const submitTicket = useCallback(async () => {
    if (!ticket.symbol || !ticket.ack) return;
    const check = sidePermit({ analyzer, liveAction, liveFreshness: desk.fresh.state }, ticket.type);
    if (!check.allowed || check.gear === null) {
      setNotice({ kind: "error", text: `Not sent: ${check.message}` });
      return;
    }
    await act("/api/spy/ticket", { type: ticket.type, symbol: ticket.symbol, acknowledgeDryRun: true, analyzedGear: check.gear }, (a) => {
      setNotice({ kind: a.ok ? "ok" : "error", text: a.ok ? (a.message ?? "Dry-run position recorded.") : (a.error ?? "The ticket was refused.") });
      if (a.ok) setTicket(FIRST_TICKET);
    });
  }, [ticket, act, analyzer, liveAction, desk.fresh.state]);

  const submitClose = useCallback(
    async (unpriced: boolean) => {
      if (!close.ack) return;
      await act("/api/spy/close", unpriced ? { acknowledgeDryRun: true, unpriced: true } : { acknowledgeDryRun: true }, (a) => {
        setNotice({ kind: a.ok ? "ok" : "error", text: a.ok ? (a.message ?? "Dry-run position closed.") : (a.error ?? "Close was refused.") });
        setClose(a.ok ? IDLE_CLOSE : { stage: "confirm", ack: false, offerUnpriced: a.code === "NO_QUOTE" });
      });
    },
    [close.ack, act],
  );

  const submitAuto = useCallback(
    async (on: boolean) => {
      if (on && !autoUi.ack) return;
      await act("/api/spy/auto", { on, acknowledgeDryRun: true }, (a) => {
        setNotice({ kind: a.ok ? "ok" : "error", text: a.ok ? (a.message ?? "Auto switch updated.") : (a.error ?? "The switch was refused.") });
        if (a.ok) setAutoUi(IDLE_AUTO);
      });
    },
    [autoUi.ack, act],
  );

  const load: DeskLoad = desk.snapshot ? { status: "ready", snapshot: desk.snapshot } : desk.fatal ? { status: "error", error: desk.fatal } : { status: "loading" };

  return (
    <SpyDeskView
      load={load}
      busy={busy}
      notice={notice}
      ticket={ticket}
      close={close}
      autoUi={autoUi}
      fresh={desk.fresh}
      analyzer={analyzer}
      onAnalyze={() => void analyzerCore.analyze()}
      onRefresh={refresh}
      onTicketChange={(next) => setTicket((t) => ({ ...t, ...next, ack: next.symbol !== undefined || next.type !== undefined ? false : (next.ack ?? t.ack) }))}
      onSubmitTicket={() => void submitTicket()}
      onCloseChange={(next) => setClose((c) => ({ ...c, ...next }))}
      onSubmitClose={(unpriced) => void submitClose(unpriced)}
      onAutoChange={(next) => setAutoUi((u) => ({ ...u, ...next }))}
      onSubmitAuto={(on) => void submitAuto(on)}
    />
  );
}
