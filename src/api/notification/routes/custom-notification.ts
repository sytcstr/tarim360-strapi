export default {
  routes: [
    {
      method: 'PATCH',
      path: '/notifications/:notificationId/read',
      handler: 'notification.markRead',
      config: { auth: { scope: [] } },
    },
  ],
};
