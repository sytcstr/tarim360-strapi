export default {
  routes: [
    {
      method: 'POST',
      path: '/hub-contents/farmer-questions/:questionId/answers',
      handler: 'hub-content.addFarmerQuestionAnswer',
      config: { auth: { scope: [] } },
    },
  ],
};
