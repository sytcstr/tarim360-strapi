/**
 * admin-notification service
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreService(
  'api::admin-notification.admin-notification' as any,
);
