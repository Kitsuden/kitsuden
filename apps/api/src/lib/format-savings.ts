/**
 * `auto` format savings per agent and day (what the panel shows)
 * ============================================================================
 *
 * Each MCP call from an agent (and each of its REST requests that asks for `auto`)
 * measures how much its compact JSON took up and how much was actually sent
 * (lib/format-measure.ts). Here it is ADDED UP per agent, UTC day and channel in
 * memory and flushed to `agent_format_savings` (migration 0052) every
 * `FLUSH_MS`, with one UPSERT per accumulated row: a tool call does not add a
 * database write.
 *
 * Counters only: no arguments, no responses, no users. A failure when
 * flushing is logged and discarded (it is a statistic, not a quota).
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";

import { db } from "../db";
import { agentFormatSavings } from "../db/schema";

import { setSavingsListener, type FormatMeasure } from "./format-measure";
import { logger } from "./logger";

export type SavingsChannel = "mcp" | "rest";

const DUMP_MS = 15_000;

interface Accumulated extends FormatMeasure {
  agentId: string;
  day: string;
  channel: SavingsChannel;
}

const pendingItems = new Map<string, Accumulated>();
let timer: ReturnType<typeof setInterval> | null = null;

const todayKey = () => new Date().toISOString().slice(0, 10);

/** Adds a measure to the agent's pending total (does not wait for the database). */
export function registerSavings(
  agentId: string | null | undefined,
  channel: SavingsChannel,
  m: FormatMeasure
): void {
  if (!agentId || agentId.startsWith("machine-") || m.responses === 0) return;
  const day = todayKey();
  const key = `${agentId}|${day}|${channel}`;
  const a = pendingItems.get(key) ?? {
    agentId,
    day,
    channel,
    responses: 0,
    compacted: 0,
    bytesJson: 0,
    sentBytes: 0,
    tokensJson: 0,
    sentTokens: 0,
  };
  a.responses += m.responses;
  a.compacted += m.compacted;
  a.bytesJson += m.bytesJson;
  a.sentBytes += m.sentBytes;
  a.tokensJson += m.tokensJson;
  a.sentTokens += m.sentTokens;
  pendingItems.set(key, a);
  if (!timer) {
    timer = setInterval(() => void dumpSavings(), DUMP_MS);
    (timer as { unref?: () => void }).unref?.();
  }
}

/** Writes the pending totals to the database. Used by the timer and the tests. */
export async function dumpSavings(): Promise<void> {
  if (pendingItems.size === 0) return;
  const batch = [...pendingItems.values()];
  pendingItems.clear();
  for (const a of batch) {
    const row = {
      responses: a.responses,
      compacted: a.compacted,
      jsonBytes: a.bytesJson,
      sentBytes: a.sentBytes,
      jsonTokensEst: Math.round(a.tokensJson),
      sentTokensEst: Math.round(a.sentTokens),
    };
    try {
      await db
        .insert(agentFormatSavings)
        .values({ agentId: a.agentId, day: a.day, channel: a.channel, ...row })
        .onConflictDoUpdate({
          target: [agentFormatSavings.agentId, agentFormatSavings.day, agentFormatSavings.channel],
          set: {
            responses: sql`${agentFormatSavings.responses} + ${row.responses}`,
            compacted: sql`${agentFormatSavings.compacted} + ${row.compacted}`,
            jsonBytes: sql`${agentFormatSavings.jsonBytes} + ${row.jsonBytes}`,
            sentBytes: sql`${agentFormatSavings.sentBytes} + ${row.sentBytes}`,
            jsonTokensEst: sql`${agentFormatSavings.jsonTokensEst} + ${row.jsonTokensEst}`,
            sentTokensEst: sql`${agentFormatSavings.sentTokensEst} + ${row.sentTokensEst}`,
            updatedAt: new Date(),
          },
        });
    } catch (err) {
      // Agent deleted between the call and the flush (FK), database down…: the statistic is lost.
      logger.warn({ err, agentId: a.agentId }, "[format-savings] could not flush");
    }
  }
}

export interface SavingsSummary {
  responses: number;
  compacted: number;
  jsonBytes: number;
  sentBytes: number;
  savedBytes: number;
  jsonTokensEst: number;
  sentTokensEst: number;
  savedTokensEst: number;
  /** Savings in estimated tokens, 0–100 (1 decimal). */
  savedPercent: number;
}

function summarize(
  rows: {
    responses: number;
    compacted: number;
    jsonBytes: number;
    sentBytes: number;
    jsonTokensEst: number;
    sentTokensEst: number;
  }[]
): SavingsSummary {
  const t = rows.reduce(
    (acc, f) => ({
      responses: acc.responses + Number(f.responses),
      compacted: acc.compacted + Number(f.compacted),
      jsonBytes: acc.jsonBytes + Number(f.jsonBytes),
      sentBytes: acc.sentBytes + Number(f.sentBytes),
      jsonTokensEst: acc.jsonTokensEst + Number(f.jsonTokensEst),
      sentTokensEst: acc.sentTokensEst + Number(f.sentTokensEst),
    }),
    { responses: 0, compacted: 0, jsonBytes: 0, sentBytes: 0, jsonTokensEst: 0, sentTokensEst: 0 }
  );
  const savedTokensEst = t.jsonTokensEst - t.sentTokensEst;
  return {
    ...t,
    savedBytes: t.jsonBytes - t.sentBytes,
    savedTokensEst,
    savedPercent:
      t.jsonTokensEst > 0 ? Math.round((savedTokensEst / t.jsonTokensEst) * 1000) / 10 : 0,
  };
}

/**
 * What an agent saved: today, the last `days` (today included) and the
 * per-day detail. It flushes the pending totals first so the panel sees the latest.
 */
export async function agentSavings(agentId: string, days = 30) {
  await dumpSavings();
  const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .select()
    .from(agentFormatSavings)
    .where(and(eq(agentFormatSavings.agentId, agentId), gte(agentFormatSavings.day, from)))
    .orderBy(desc(agentFormatSavings.day));
  const dayValue = todayKey();
  const byDay = new Map<string, typeof rows>();
  for (const f of rows) byDay.set(f.day, [...(byDay.get(f.day) ?? []), f]);
  return {
    day: dayValue,
    today: summarize(rows.filter((f) => f.day === dayValue)),
    period: { days, ...summarize(rows) },
    daily: [...byDay.entries()].map(([day, fs]) => ({ day, ...summarize(fs) })),
    estimate:
      "o200k_base characters per token from docs/agents/benchmarks.md (JSON 3.06, TOON 3.10, TRON 2.81)",
  };
}

// When loaded, it receives the measures from the REST middleware (lib/toon.ts) and from MCP.
setSavingsListener(registerSavings);
