export default {
  routes: [
    {
      method: 'GET',
      path: '/processed-store-documents/mine',
      handler: 'processed-store-documents.mine',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/processed-store-documents/create',
      handler: 'processed-store-documents.create',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/processed-store-documents/delete',
      handler: 'processed-store-documents.delete',
      config: { auth: { scope: [] } },
    },
  ],
};
