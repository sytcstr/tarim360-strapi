/**
 * PUB-PROFILE-B — public profile read route.
 *
 * `auth: false`, same reasoning as D8-V-B's /profile-view-target: profile
 * viewing itself is guest-reachable in this app (HesabimPage/profile
 * navigation is not behind requireLogin), so gating the name/bio/avatar a
 * guest needs to render a viewed profile behind a JWT would silently
 * break profile browsing for every logged-out visitor. No identity is
 * ever inspected by this action (only the requested :ownerId), so the
 * rate limiter below falls back to IP-keying for every caller -- the
 * relevant dimension for this route's real risk (ownerId enumeration),
 * not a gap.
 */
export default {
  routes: [
    {
      method: 'GET',
      path: '/public-profiles/:ownerId',
      handler: 'public-profile.getPublicProfile',
      config: {
        auth: false,
        middlewares: [
          { name: 'global::engagement-rate-limit', config: { windowMs: 60_000, max: 30 } },
        ],
      },
    },
  ],
};
