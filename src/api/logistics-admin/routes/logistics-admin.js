'use strict';

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/logistics-admin/access',
      handler: 'logistics-admin.access',
      config: { auth: { scope: [] } },
    },
    {
      method: 'GET',
      path: '/logistics-admin/loads',
      handler: 'logistics-admin.loads',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/logistics-admin/load-review',
      handler: 'logistics-admin.loadReview',
      config: { auth: { scope: [] } },
    },
    {
      method: 'GET',
      path: '/logistics-admin/vehicles',
      handler: 'logistics-admin.vehicles',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/logistics-admin/vehicle-review',
      handler: 'logistics-admin.vehicleReview',
      config: { auth: { scope: [] } },
    },
    {
      method: 'GET',
      path: '/logistics-admin/offers',
      handler: 'logistics-admin.offers',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/logistics-admin/offer-review',
      handler: 'logistics-admin.offerReview',
      config: { auth: { scope: [] } },
    },
  ],
};

