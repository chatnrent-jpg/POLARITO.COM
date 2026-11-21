"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseDeskSnapshot } from "@/lib/spyDesk";
import SpyDeskView, { type AutoUi, type CloseUi, type DeskLoad, type Notice, type TicketUi } from "@/components/spy/SpyDeskView";

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
 * Container: owns the fetching and the small UI state, and hands plain data to the pure view.
 * Every network call is in try/catch, the snapshot is shape-checked before it is drawn, and after any manual action the
 * page reloads the server's own data instead of assuming what happened.
 */
export default function SpyDesk() {
  const [load, setLoad] = useState<DeskLoad>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [ticket, setTicket] = useState<TicketUi>(FIRST_TICKET);
  const [close, setClose] = useState<CloseUi>(IDLE_CLOSE);
  const [autoUi, setAutoUi] = useState<AutoUi>(IDLE_AUTO);
  const alive = useRef(true);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/spy/desk", { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        const err = typeof data === "object" && data !== null && typeof (data as { error?: unknown }).error === "string" ? (data as { error: string }).error : `The server answered ${res.status}.`;
        if (alive.current) setLoad({ status: "error", error: err });
        return;
      }
      const parsed = parseDeskSnapshot(data);
      if (alive.current) setLoad(parsed.ok ? { status: "ready", snapshot: parsed.snapshot } : { status: "error", error: parsed.error });
    } catch {
      if (alive.current) setLoad({ status: "error", error: "Could not reach the server. Nothing is shown rather than guessing." });
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const first = window.setTimeout(() => void reload(), 0);
    return () => {
      alive.current = false;
      window.clearTimeout(first);
    };
  }, [reload]);

  const refresh = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    await reload();
    if (alive.current) setBusy(false);
  }, [reload]);

  const post = useCallback(
    async (path: string, body: unknown): Promise<ApiAnswer> => {
      try {
        const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
        return await readAnswer(res);
      } catch {
        return { ok: false, error: "Could not reach the server. Nothing was changed; check the state shown." };
      }
    },
    [],
  );

  const submitTicket = useCallback(async () => {
    if (!ticket.symbol || !ticket.ack) return;
    setBusy(true);
    setNotice(null);
    const a = await post("/api/spy/ticket", { type: ticket.type, symbol: ticket.symbol, acknowledgeDryRun: true });
    if (alive.current) {
      setNotice({ kind: a.ok ? "ok" : "error", text: a.ok ? (a.message ?? "Dry-run position recorded.") : (a.error ?? "The ticket was refused.") });
      if (a.ok) setTicket(FIRST_TICKET);
    }
    await reload();
    if (alive.current) setBusy(false);
  }, [ticket, post, reload]);

  const submitClose = useCallback(
    async (unpriced: boolean) => {
      if (!close.ack) return;
      setBusy(true);
      setNotice(null);
      const a = await post("/api/spy/close", unpriced ? { acknowledgeDryRun: true, unpriced: true } : { acknowledgeDryRun: true });
      if (alive.current) {
        setNotice({ kind: a.ok ? "ok" : "error", text: a.ok ? (a.message ?? "Dry-run position closed.") : (a.error ?? "Close was refused.") });
        setClose(a.ok ? IDLE_CLOSE : { stage: "confirm", ack: false, offerUnpriced: a.code === "NO_QUOTE" });
      }
      await reload();
      if (alive.current) setBusy(false);
    },
    [close.ack, post, reload],
  );

  const submitAuto = useCallback(
    async (on: boolean) => {
      if (on && !autoUi.ack) return;
      setBusy(true);
      setNotice(null);
      const a = await post("/api/spy/auto", { on, acknowledgeDryRun: true });
      if (alive.current) {
        setNotice({ kind: a.ok ? "ok" : "error", text: a.ok ? (a.message ?? "Auto switch updated.") : (a.error ?? "The switch was refused.") });
        if (a.ok) setAutoUi(IDLE_AUTO);
      }
      await reload();
      if (alive.current) setBusy(false);
    },
    [autoUi.ack, post, reload],
  );

  return (
    <SpyDeskView
      load={load}
      busy={busy}
      notice={notice}
      ticket={ticket}
      close={close}
      autoUi={autoUi}
      onRefresh={() => void refresh()}
      onTicketChange={(next) => setTicket((t) => ({ ...t, ...next, ack: next.symbol !== undefined || next.type !== undefined ? false : (next.ack ?? t.ack) }))}
      onSubmitTicket={() => void submitTicket()}
      onCloseChange={(next) => setClose((c) => ({ ...c, ...next }))}
      onSubmitClose={(unpriced) => void submitClose(unpriced)}
      onAutoChange={(next) => setAutoUi((u) => ({ ...u, ...next }))}
      onSubmitAuto={(on) => void submitAuto(on)}
    />
  );
}
