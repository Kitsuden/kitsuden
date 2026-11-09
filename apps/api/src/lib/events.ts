import { EventEmitter } from "events";

type AnyListener = (event: string, data: unknown) => void;

class SystemEvents extends EventEmitter {
  #any: AnyListener[] = [];

  constructor() {
    super();
    this.setMaxListeners(20);
  }

  /**
   * Hears every event, whatever its name. Kons name their own events (`crm:deal:stage-changed`), and
   * whoever reacts to them (the actions engine) cannot know those names in advance.
   */
  onAny(listener: AnyListener): void {
    if (!this.#any.includes(listener)) this.#any.push(listener);
  }

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    const heard = super.emit(event, ...args);
    if (typeof event === "string") {
      for (const listener of this.#any) {
        // A listener that throws must not break whoever emitted the event.
        try {
          listener(event, args[0]);
        } catch {
          // Listeners report their own errors.
        }
      }
    }
    return heard;
  }
}

export const events = new SystemEvents();
export const hooks = events;
