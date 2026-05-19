'use strict';

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/logistics-admin/access',
      handler: 'logistics-admin.access',
      config: { auth: true },
    },
    {
      method: 'GET',
      path: '/logistics-admin/loads',
      handler: 'logistics-admin.loads',
      config: { auth: true },
    },
    {
      method: 'POST',
      path: '/logistics-admin/load-review',
      handler: 'logistics-admin.loadReview',
      config: { auth: true },
    },
    {
      method: 'GET',
      path: '/logistics-admin/vehicles',
      handler: 'logistics-admin.vehicles',
      config: { auth: true },
    },
    {
      method: 'POST',
      path: '/logistics-admin/vehicle-review',
      handler: 'logistics-admin.vehicleReview',
      config: { auth: true },
    },
    {
      method: 'GET',
      path: '/logistics-admin/offers',
      handler: 'logistics-admin.offers',
      config: { auth: true },
    },
    {
      method: 'POST',
      path: '/logistics-admin/offer-review',
      handler: 'logistics-admin.offerReview',
      config: { auth: true },
    },
  ],
};
