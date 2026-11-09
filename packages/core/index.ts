/**
 * @kitsuden/core — Kitsuden Core (Level 2: the framework's batteries)
 *
 * `packages/core/` is the home of Kitsuden's CORE capabilities: the modules
 * that EVERY app would want, whatever the domain (unlike the domain
 * kons in `packages/kons/`, e.g. games/crm/lms).
 *
 * Core modules that live here as their own packages (loaded by the
 * module-loader via SOURCE 0, keeping their `kon-*` manifest id as a stable
 * key):
 *   - datasets/  (@kitsuden/datasets)  — dynamic collections + REST auto-API
 *   - media/     (@kitsuden/media)     — S3/MinIO storage + optimization
 *   - blocks/    (@kitsuden/blocks)    — page builder foundation
 *   - vector-search/                — embeddings + semantic search
 *   - content-publishing/           — publishing utilities
 *
 * Other core capabilities live in the Engine (Level 1, `packages/engine/`):
 * brain, code-graph, system-map, authz, repo, validation. And as host
 * services: vault + secrets (apps/api/src/services/{vault,secrets}.ts).
 * See CORE.md for the full map of the hierarchy.
 */

// Vector search (Engine infrastructure)
export * from "./vector-search";

// Content Publishing (Core API)
export * from "./content-publishing";
