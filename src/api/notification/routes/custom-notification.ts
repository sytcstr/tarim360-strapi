export default {
  routes: [
    {
      method: 'PATCH',
      path: '/notifications/:notificationId/read',
      handler: 'notification.markRead',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/notifications/domain-event',
      handler: 'notification.createDomainEvent',
      config: { auth: { scope: [] } },
    },
  ],
};
