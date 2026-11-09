/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TEST EVENT TRACKING
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { TestEvents } from "./types.js";

interface EmittedEvent {
  name: string;
  data: any;
  timestamp: Date;
}

/**
 * Create event tracker for testing
 */
export function createTestEvents(): TestEvents {
  const events: EmittedEvent[] = [];

  return {
    get all() {
      return [...events];
    },

    wasEmitted: (name: string, data?: Record<string, any>): boolean => {
      return events.some((e) => {
        if (e.name !== name) return false;
        if (!data) return true;

        // Check if event data matches
        return Object.entries(data).every(([key, value]) => {
          return e.data?.[key] === value;
        });
      });
    },

    last: <_T = any>(name: string): EmittedEvent | undefined => {
      return [...events].reverse().find((e) => e.name === name);
    },

    clear: () => {
      events.length = 0;
    },
  };
}

export default { createTestEvents };
