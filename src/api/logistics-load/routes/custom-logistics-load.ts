export default {
  routes: [
    {
      method: 'GET',
      path: '/logistics-loads/nearby',
      handler: 'logistics-load.nearby',
      config: { auth: false },
    },
  ],
};
