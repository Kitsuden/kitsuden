/**
 * Kitsuden — SLOs, Error Budgets and Symptom-based Alerting
 * ============================================================================
 *
 * Practices #3 (SLIs/SLOs/Error Budgets) and #4 (Alert on Symptoms, not Causes)
 * of the observability manual.
 *
 * - SLO: target for an SLI (e.g. 99.9% success, p99 < 500ms).
 * - Error budget: 1 - SLO. If SLO=99.9%, budget=0.1% of requests may fail.
 * - Burn rate: how fast the budget is being consumed (alert if high).
 * - Symptom-based alerting: only symptoms are "paged" (user impact:
 *   error rate, p99 latency); causes (CPU, memory) go to a ticket, not a page.
 */

import { getMetricsSnapshot, type MetricsSnapshot } from "./metrics";

// ── SLO configuration (with sensible defaults, overridable by env) ────────────

export interface SloConfig {
  /** Availability target (success rate). E.g. 0.999 = 99.9%. */
  availabilityTarget: number;
  /** p99 latency target in ms. */
  latencyP99Ms: number;
  /** Evaluation window in minutes. */
  windowMinutes: number;
  /** Burn rate that triggers a page (multiple of normal budget consumption). */
  burnRatePageThreshold: number;
}

export const sloConfig: SloConfig = {
  availabilityTarget: Number(process.env.SLO_AVAILABILITY ?? "0.999"),
  latencyP99Ms: Number(process.env.SLO_LATENCY_P99_MS ?? "500"),
  windowMinutes: Number(process.env.SLO_WINDOW_MINUTES ?? "60"),
  burnRatePageThreshold: Number(process.env.SLO_BURN_PAGE ?? "2"),
};

// ── SLO / error budget evaluation ─────────────────────────────────────────────

export interface SloStatus {
  window: MetricsSnapshot;
  availability: {
    sli: number; // observed success rate
    slo: number; // target
    met: boolean;
    errorBudget: number; // 1 - slo
    budgetConsumed: number; // fraction of the budget already spent [0..>1]
    budgetRemaining: number; // remaining fraction [<0..1]
    burnRate: number; // errorRate / errorBudget
  };
  latency: {
    p99: number;
    slo: number;
    met: boolean;
  };
}

export function evaluateSlo(config: SloConfig = sloConfig): SloStatus {
  const snap = getMetricsSnapshot(config.windowMinutes);
  const errorBudget = 1 - config.availabilityTarget;
  const budgetConsumed = errorBudget > 0 ? snap.errorRate / errorBudget : 0;
  const burnRate = budgetConsumed; // over the window, consumption relative to the budget

  return {
    window: snap,
    availability: {
      sli: snap.successRate,
      slo: config.availabilityTarget,
      met: snap.successRate >= config.availabilityTarget,
      errorBudget,
      budgetConsumed,
      budgetRemaining: 1 - budgetConsumed,
      burnRate,
    },
    latency: {
      p99: snap.latency.p99,
      slo: config.latencyP99Ms,
      met: snap.latency.p99 <= config.latencyP99Ms || snap.total === 0,
    },
  };
}

// ── Symptom-based alerting (practice #4) ──────────────────────────────────────

export type AlertKind = "symptom" | "cause" | "predictive";
export type AlertSeverity = "page" | "ticket" | "info";

export interface Alert {
  kind: AlertKind;
  severity: AlertSeverity;
  name: string;
  message: string;
  value: number;
  threshold: number;
  action: string;
}

/**
 * Evaluates SYMPTOM alerts from the SLIs. Only these justify a page
 * (real user impact). Causes (CPU/memory/disk) are evaluated separately and
 * NEVER page — they go to a ticket. Golden rule of the manual.
 */
export function evaluateSymptomAlerts(config: SloConfig = sloConfig): Alert[] {
  const status = evaluateSlo(config);
  const alerts: Alert[] = [];

  // Without enough traffic, we do not alert (avoids false positives).
  if (status.window.total < 20) return alerts;

  // Symptom 1: high error budget burn rate → page.
  if (status.availability.burnRate >= config.burnRatePageThreshold) {
    alerts.push({
      kind: "symptom",
      severity: "page",
      name: "error_budget_burn",
      message: `Error budget burning fast: ${(status.window.errorRate * 100).toFixed(2)}% of 5xx errors (SLO ${(config.availabilityTarget * 100).toFixed(1)}%)`,
      value: Number(status.availability.burnRate.toFixed(2)),
      threshold: config.burnRatePageThreshold,
      action: "Page: investigate the trace of recent 5xx requests",
    });
  }

  // Symptom 2: p99 latency exceeds the SLO → page.
  if (!status.latency.met) {
    alerts.push({
      kind: "symptom",
      severity: "page",
      name: "latency_p99_breach",
      message: `p99 latency ${status.latency.p99}ms exceeds SLO ${config.latencyP99Ms}ms`,
      value: status.latency.p99,
      threshold: config.latencyP99Ms,
      action: "Page: find the slowest trace and pivot to its logs",
    });
  }

  return alerts;
}

/**
 * Evaluates CAUSE alerts (system resources). They never page: they go to a ticket.
 * Explicit distinction from practice #4.
 */
export function evaluateCauseAlerts(): Alert[] {
  const alerts: Alert[] = [];
  const mem = process.memoryUsage();
  const heapRatio = mem.heapUsed / mem.heapTotal;

  if (heapRatio > 0.9) {
    alerts.push({
      kind: "cause",
      severity: "ticket",
      name: "heap_pressure",
      message: `Heap usage ${(heapRatio * 100).toFixed(0)}% (cause, not symptom)`,
      value: Number(heapRatio.toFixed(2)),
      threshold: 0.9,
      action: "Ticket for SRE — do not page unless it impacts an SLI",
    });
  }

  return alerts;
}

export interface AlertReport {
  generatedAt: string;
  slo: SloStatus;
  symptoms: Alert[];
  causes: Alert[];
  /** true if there is any symptom that warrants a page. */
  paging: boolean;
}

export function buildAlertReport(config: SloConfig = sloConfig): AlertReport {
  const symptoms = evaluateSymptomAlerts(config);
  const causes = evaluateCauseAlerts();
  return {
    generatedAt: new Date().toISOString(),
    slo: evaluateSlo(config),
    symptoms,
    causes,
    paging: symptoms.some((a) => a.severity === "page"),
  };
}
