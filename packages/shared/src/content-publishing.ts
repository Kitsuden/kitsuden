/**
 * Content Publishing Registry
 *
 * Manages content targets for promoting data to different outputs
 * (Blog, CMS, Email, etc.)
 */

import type { KonContext, ContentTarget } from "./kon-api";

export class ContentPublishingRegistry {
  private targets = new Map<string, ContentTarget>();
  private ctx: KonContext;

  constructor(ctx: KonContext) {
    this.ctx = ctx;
  }

  /**
   * Register a content target
   */
  register(target: ContentTarget): void {
    this.targets.set(target.id, target);
    this.ctx.logger.info(`Content target registered: ${target.id}`);
  }

  /**
   * Unregister a content target
   */
  unregister(targetId: string): void {
    this.targets.delete(targetId);
    this.ctx.logger.info(`Content target unregistered: ${targetId}`);
  }

  /**
   * Get a content target by ID
   */
  get(targetId: string): ContentTarget | undefined {
    return this.targets.get(targetId);
  }

  /**
   * Get all registered content targets
   */
  getAll(): ContentTarget[] {
    return Array.from(this.targets.values());
  }

  /**
   * Check if a target is registered
   */
  has(targetId: string): boolean {
    return this.targets.has(targetId);
  }
}

// Re-export types
export type { ContentTarget } from "./kon-api";
