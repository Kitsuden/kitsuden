/**
 * Kitsuden — Content Publishing API (Level 2: Core)
 *
 * Abstract content publishing system that lets any
 * kon promote data to a "Content Target" (Blog, Docs, Shop, etc.)
 */

import type { KonContext, ContentTarget, ContentTargetInfo } from "@kitsuden/shared";

/**
 * Global registry of Content Targets.
 * Always available in KonContext.contentPublishing.
 */
export class ContentPublishingRegistry {
  private targets = new Map<string, ContentTarget>();
  private ctx: KonContext;

  constructor(ctx: KonContext) {
    this.ctx = ctx;
  }

  register(target: ContentTarget): void {
    if (this.targets.has(target.id)) {
      this.ctx.logger.warn(
        `ContentTarget '${target.id}' is being re-registered by ${target.konId}`
      );
    }
    this.targets.set(target.id, target);
    this.ctx.logger.info(`ContentTarget registered: '${target.id}' (${target.name})`);
  }

  unregister(targetId: string): void {
    const target = this.targets.get(targetId);
    if (target) {
      this.targets.delete(targetId);
      this.ctx.logger.info(`ContentTarget unregistered: '${targetId}' (${target.name})`);
    }
  }

  getAvailableTargets(): ContentTargetInfo[] {
    return Array.from(this.targets.values()).map((target) => ({
      id: target.id,
      name: target.name,
      konId: target.konId,
      capabilities: target.capabilities,
    }));
  }

  hasTarget(targetId: string): boolean {
    return this.targets.has(targetId);
  }

  async promote(targetId: string, data: any): Promise<any> {
    const target = this.targets.get(targetId);
    if (!target) {
      throw new Error(`Content target '${targetId}' is not available`);
    }
    return target.publish(data, this.ctx);
  }

  async unpublish(targetId: string, contentId: string): Promise<void> {
    const target = this.targets.get(targetId);
    if (!target?.unpublish) {
      throw new Error(`Content target '${targetId}' does not support unpublish`);
    }
    return target.unpublish(contentId, this.ctx);
  }

  getPublishedUrl(targetId: string, result: any): string {
    const target = this.targets.get(targetId);
    if (!target) return result.url;
    return target.getPublishedUrl(result);
  }
}

// Re-export types for convenience
export type { ContentTarget, ContentTargetInfo } from "@kitsuden/shared";
