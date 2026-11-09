/**
 * Kitsuden - Structured Logging
 *
 * Pino-based logger with context support for tracing requests
 * and structured log output for production monitoring.
 *
 * NOTE: pino-pretty is NOT used via transport (incompatible with Bun bundler).
 * In development, we use pino's built-in formatters for readable output.
 * In production, structured JSON logs are emitted for Grafana/Loki/etc.
 */

import pino from "pino";

import { rawNodeEnv } from "./environment";
import { getTraceLogFields } from "./tracing";

const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const NODE_ENV = rawNodeEnv() || "development";
const isDev = NODE_ENV === "development";

// Base logger instance
// In production: structured JSON (machine-readable for Loki/Grafana)
// In development: still JSON but with timestamp and readable level
//
// Practice #1 (Structured Logging) + #5 (Log-Trace Correlation): each log carries
// standard fields (ISO timestamp, level, service_name, message) and, via the mixin,
// the trace_id/span_id of the active request (AsyncLocalStorage) WITHOUT passing them by hand.
export const logger = pino({
  level: LOG_LEVEL,
  base: {
    service_name: "kitsuden-api",
    service: "kitsuden-api", // compat with previous logs
    version: "0.9.0-beta",
    env: NODE_ENV,
  },
  // ISO 8601 with zone (UTC) in both dev and prod for querying/aggregation.
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label: string) {
      return { level: label.toUpperCase() };
    },
  },
  // Injects trace_id/span_id/requestId from the active context into each line.
  mixin() {
    return getTraceLogFields();
  },
  // Safety net in case someone logs a request or an object with credentials: today
  // no log carries them, but nothing prevented it (an earlier audit).
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "headers.authorization",
      "headers.cookie",
      "*.password",
      "*.token",
      "*.apiKey",
      "*.secret",
      "*.plainApiKey",
      "password",
      "token",
      "plainApiKey",
    ],
    censor: "[redacted]",
  },
});

// Create child logger with request context
export function createRequestLogger(requestId: string, userId?: string) {
  return logger.child({
    requestId,
    userId: userId || "anonymous",
    type: "request",
  });
}

// Performance logger
export function createPerformanceLogger(operation: string) {
  const startTime = Date.now();

  return {
    finish: (metadata?: Record<string, unknown>) => {
      const duration = Date.now() - startTime;
      logger.info(
        {
          operation,
          duration,
          type: "performance",
          ...metadata,
        },
        `${operation} completed in ${duration}ms`
      );
    },
    error: (error: Error, metadata?: Record<string, unknown>) => {
      const duration = Date.now() - startTime;
      logger.error(
        {
          operation,
          duration,
          error: error.message,
          type: "performance-error",
          ...metadata,
        },
        `${operation} failed after ${duration}ms`
      );
    },
  };
}

// Database query logger
export function logQuery(sql: string, params: unknown[], duration: number, error?: Error) {
  const logData = {
    type: "query",
    sql: sql.substring(0, 200),
    paramsCount: params.length,
    duration,
    slow: duration > 1000,
  };

  if (error) {
    logger.error({ ...logData, error: error.message }, "Query failed");
  } else if (duration > 1000) {
    logger.warn(logData, "Slow query detected");
  } else {
    logger.debug(logData, "Query executed");
  }
}

// Security event logger
export function logSecurity(
  event: string,
  details: {
    userId?: string;
    ip?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
  }
) {
  logger.warn(
    {
      type: "security",
      event,
      ...details,
    },
    `Security: ${event}`
  );
}

export default logger;
