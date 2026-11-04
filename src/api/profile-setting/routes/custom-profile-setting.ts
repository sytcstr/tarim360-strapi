export default {
  routes: [
    {
      method: 'POST',
      path: '/profile-settings/:profileId/rate',
      handler: 'profile-setting.rateProfile',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/profile-settings/:profileId/comments',
      handler: 'profile-setting.addProfileComment',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/profile-settings/:profileId/follow',
      handler: 'profile-setting.followProfile',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/profile-settings/:profileId/unfollow',
      handler: 'profile-setting.unfollowProfile',
      config: { auth: { scope: [] } },
    },
    {
      method: 'DELETE',
      path: '/profile-settings/:profileId/comments/:commentId',
      handler: 'profile-setting.deleteProfileComment',
      config: { auth: { scope: [] } },
    },
  ],
};
