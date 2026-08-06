/**
 * Faz D8-V-B — profile-view-target lookup route.
 *
 * `auth: false`, matching `/engagements/view`'s own precedent (routes/
 * engagement-v1.ts): profile viewing itself is guest-reachable in this
 * app (HesabimPage/profile navigation is not behind requireLogin), so
 * gating the lookup a guest needs in order to even call
 * POST /engagements/view behind a JWT would silently break view
 * counting for every logged-out viewer. No `engagement-soft-auth` is
 * needed here (unlike /engagements/view) -- this action never inspects
 * the caller's identity, only the requested `:ownerId` -- so the rate
 * limiter below falls back to IP-keying for every caller, which is
 * actually the more relevant dimension for this route's real risk
 * (mitigating ownerId enumeration), not a gap.
 */
export default {
  routes: [
    {
      method: 'GET',
      path: '/profile-view-target/:ownerId',
      handler: 'engagement-profile.getViewTarget',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::engagement-rate-limit', config: { windowMs: 60_000, max: 30 } },
        ],
      },
    },
  ],
};
