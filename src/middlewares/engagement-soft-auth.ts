/**
 * Optional-auth middleware for engagement routes that must stay reachable
 * by guests (POST /engagements/view — ENGAGEMENT_API_CONTRACT.md §2/§4.3)
 * but should still recognize a logged-in caller when a valid JWT is sent.
 *
 * Confirmed via a real boot (Faz B-V) that Strapi's own `auth:false` route
 * config skips JWT verification ENTIRELY — `ctx.state.user` is never
 * populated on such routes even when a valid Bearer token is present.
 * There is no built-in "optional auth" mode in the route config, so this
 * middleware does the JWT verification itself, using the exact same
 * users-permissions JWT service Strapi's own auth pipeline uses
 * (`@strapi/plugin-users-permissions`'s `jwt` service) — not a
 * reimplementation. On a missing/invalid/expired token it does nothing
 * and calls next(); it never rejects the request itself (that is exactly
 * the point — auth stays optional here).
 */
export default (_config: unknown, { strapi }: any) => {
  return async (ctx: any, next: () => Promise<void>) => {
    const authHeader = ctx.request?.header?.authorization;
    if (authHeader) {
      try {
        const jwtService = strapi.plugin('users-permissions').service('jwt');
        const payload = await jwtService.getToken(ctx);
        const userId = payload?.id;
        if (userId) {
          const user = await strapi.db
            .query('plugin::users-permissions.user')
            .findOne({ where: { id: userId } });
          if (user) {
            ctx.state.user = user;
          }
        }
      } catch (_e) {
        // Invalid/expired token on an auth-optional route: proceed as a
        // guest rather than rejecting — the route itself decides whether
        // a guestActorId is acceptable instead.
      }
    }
    await next();
  };
};
