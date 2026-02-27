/**
 * profile-setting router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter(
  'api::profile-setting.profile-setting',
  {
    config: {
      find: {
        policies: ['global::profile-setting-ownership'],
      },
      findOne: {
        policies: ['global::profile-setting-ownership'],
      },
      create: {
        policies: ['global::profile-setting-ownership'],
      },
      update: {
        policies: ['global::profile-setting-ownership'],
      },
      delete: {
        policies: ['global::profile-setting-ownership'],
      },
    },
  },
);
