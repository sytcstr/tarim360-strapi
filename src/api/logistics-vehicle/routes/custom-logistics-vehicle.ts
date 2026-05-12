export default {
  routes: [
    {
      method: 'GET',
      path: '/logistics-vehicles/nearby',
      handler: 'logistics-vehicle.nearby',
      config: { auth: false },
    },
  ],
};
