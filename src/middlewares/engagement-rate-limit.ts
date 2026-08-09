/**
 * Minimal, dependency-free rate-limit middleware for the Engagement API's
 * auth-less routes (ENGAGEMENT_API_CONTRACT.md §9 — this is explicitly
 * disclosed technical debt, not a production-grade rate limiter).
 *
 * Known limitations (do not report this as a solved problem):
 * - In-memory only: state is per Node process, resets on restart, and
 *   provides NO protection at all across multiple instances/processes.
 *   This project currently runs on SQLite (see ENGAGEMENT_API_CONTRACT.md
 *   §3.3 / STRAPI_ENGAGEMENT_BACKEND_AUDIT...md), which itself implies a
 *   single-instance deployment today — so this gives real protection in
 *   the CURRENT deployment shape, but would need to move to a shared
 *   store (Redis etc.) before any multi-instance/horizontal-scale setup.
 * - Fixed window (not sliding/token-bucket) — bursty right at window
 *   boundaries can exceed the nominal rate by up to 2x. Acceptable for
 *   "stop obvious abuse," not for precise rate guarantees.
 * - Keyed by actor (JWT identity) when available, else by IP — an
 *   attacker spraying requests across many IPs is not mitigated by this
 *   alone.
 *
 * Config (per-route, via `config.engagementRateLimit` in the route
 * definition — see routes/engagement-v1.ts): `{ windowMs, max }`. No
 * hard-coded limits: every route using this middleware must pass its own
 * config explicitly.
 */
import { sendEngagementError } from '../utils/engagement-contract';

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

const keyFor = (ctx: any): string => {
  const email = (ctx?.state?.user?.email ?? '').toString().trim().toLowerCase();
  if (email) return `user:${email}`;
  return `ip:${ctx.request?.ip ?? ctx.ip ?? 'unknown'}`;
};

export default (config: { windowMs?: number; max?: number } = {}, { strapi: _strapi }: any) => {
  const windowMs = Number(config.windowMs) > 0 ? Number(config.windowMs) : 60_000;
  const max = Number(config.max) > 0 ? Number(config.max) : 30;

  return async (ctx: any, next: () => Promise<void>) => {
    const routeKey = `${ctx.method} ${ctx.path}`;
    const key = `${routeKey}::${keyFor(ctx)}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > max) {
      return sendEngagementError(
        ctx,
        'RATE_LIMITED',
        'Çok fazla istek gönderildi, lütfen bekleyin.',
      );
    }

    await next();
  };
};
