export default {
  routes: [
    {
      method: 'POST',
      path: '/ai/agri-assistant',
      handler: 'ai.agriAssistant',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/ai/agri-vision',
      handler: 'ai.agriVision',
      config: { auth: { scope: [] } },
    },
    {
      method: 'GET',
      path: '/ai/history',
      handler: 'ai.history',
      config: { auth: { scope: [] } },
    },
    {
      method: 'GET',
      path: '/ai/usage-summary',
      handler: 'ai.usageSummary',
      config: { auth: { scope: [] } },
    },
  ],
};
