import type { Schema, Struct } from '@strapi/strapi';

export interface AdminApiToken extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_api_tokens';
  info: {
    description: '';
    displayName: 'Api Token';
    name: 'Api Token';
    pluralName: 'api-tokens';
    singularName: 'api-token';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    accessKey: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    adminPermissions: Schema.Attribute.Relation<
      'oneToMany',
      'admin::permission'
    >;
    adminUserOwner: Schema.Attribute.Relation<'manyToOne', 'admin::user'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }> &
      Schema.Attribute.DefaultTo<''>;
    encryptedKey: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    expiresAt: Schema.Attribute.DateTime;
    kind: Schema.Attribute.Enumeration<['content-api', 'admin']> &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'content-api'>;
    lastUsedAt: Schema.Attribute.DateTime;
    lifespan: Schema.Attribute.BigInteger;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::api-token'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    permissions: Schema.Attribute.Relation<
      'oneToMany',
      'admin::api-token-permission'
    >;
    publishedAt: Schema.Attribute.DateTime;
    type: Schema.Attribute.Enumeration<['read-only', 'full-access', 'custom']> &
      Schema.Attribute.DefaultTo<'read-only'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface AdminApiTokenPermission extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_api_token_permissions';
  info: {
    description: '';
    displayName: 'API Token Permission';
    name: 'API Token Permission';
    pluralName: 'api-token-permissions';
    singularName: 'api-token-permission';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    action: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'admin::api-token-permission'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    token: Schema.Attribute.Relation<'manyToOne', 'admin::api-token'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface AdminPermission extends Struct.CollectionTypeSchema {
  collectionName: 'admin_permissions';
  info: {
    description: '';
    displayName: 'Permission';
    name: 'Permission';
    pluralName: 'permissions';
    singularName: 'permission';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    action: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    actionParameters: Schema.Attribute.JSON & Schema.Attribute.DefaultTo<{}>;
    apiToken: Schema.Attribute.Relation<'manyToOne', 'admin::api-token'>;
    conditions: Schema.Attribute.JSON & Schema.Attribute.DefaultTo<[]>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::permission'> &
      Schema.Attribute.Private;
    properties: Schema.Attribute.JSON & Schema.Attribute.DefaultTo<{}>;
    publishedAt: Schema.Attribute.DateTime;
    role: Schema.Attribute.Relation<'manyToOne', 'admin::role'>;
    subject: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface AdminRole extends Struct.CollectionTypeSchema {
  collectionName: 'admin_roles';
  info: {
    description: '';
    displayName: 'Role';
    name: 'Role';
    pluralName: 'roles';
    singularName: 'role';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    code: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::role'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    permissions: Schema.Attribute.Relation<'oneToMany', 'admin::permission'>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    users: Schema.Attribute.Relation<'manyToMany', 'admin::user'>;
  };
}

export interface AdminSession extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_sessions';
  info: {
    description: 'Session Manager storage';
    displayName: 'Session';
    name: 'Session';
    pluralName: 'sessions';
    singularName: 'session';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
    i18n: {
      localized: false;
    };
  };
  attributes: {
    absoluteExpiresAt: Schema.Attribute.DateTime & Schema.Attribute.Private;
    childId: Schema.Attribute.String & Schema.Attribute.Private;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    deviceId: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Private;
    expiresAt: Schema.Attribute.DateTime &
      Schema.Attribute.Required &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::session'> &
      Schema.Attribute.Private;
    origin: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    sessionId: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Private &
      Schema.Attribute.Unique;
    status: Schema.Attribute.String & Schema.Attribute.Private;
    type: Schema.Attribute.String & Schema.Attribute.Private;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    userId: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Private;
  };
}

export interface AdminTransferToken extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_transfer_tokens';
  info: {
    description: '';
    displayName: 'Transfer Token';
    name: 'Transfer Token';
    pluralName: 'transfer-tokens';
    singularName: 'transfer-token';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    accessKey: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }> &
      Schema.Attribute.DefaultTo<''>;
    expiresAt: Schema.Attribute.DateTime;
    lastUsedAt: Schema.Attribute.DateTime;
    lifespan: Schema.Attribute.BigInteger;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'admin::transfer-token'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    permissions: Schema.Attribute.Relation<
      'oneToMany',
      'admin::transfer-token-permission'
    >;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface AdminTransferTokenPermission
  extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_transfer_token_permissions';
  info: {
    description: '';
    displayName: 'Transfer Token Permission';
    name: 'Transfer Token Permission';
    pluralName: 'transfer-token-permissions';
    singularName: 'transfer-token-permission';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    action: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'admin::transfer-token-permission'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    token: Schema.Attribute.Relation<'manyToOne', 'admin::transfer-token'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface AdminUser extends Struct.CollectionTypeSchema {
  collectionName: 'admin_users';
  info: {
    description: '';
    displayName: 'User';
    name: 'User';
    pluralName: 'users';
    singularName: 'user';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    apiTokens: Schema.Attribute.Relation<'oneToMany', 'admin::api-token'> &
      Schema.Attribute.Private;
    blocked: Schema.Attribute.Boolean &
      Schema.Attribute.Private &
      Schema.Attribute.DefaultTo<false>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    email: Schema.Attribute.Email &
      Schema.Attribute.Required &
      Schema.Attribute.Private &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 6;
      }>;
    firstname: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    isActive: Schema.Attribute.Boolean &
      Schema.Attribute.Private &
      Schema.Attribute.DefaultTo<false>;
    lastname: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::user'> &
      Schema.Attribute.Private;
    password: Schema.Attribute.Password &
      Schema.Attribute.Private &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 6;
      }>;
    preferedLanguage: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    registrationToken: Schema.Attribute.String & Schema.Attribute.Private;
    resetPasswordToken: Schema.Attribute.String & Schema.Attribute.Private;
    roles: Schema.Attribute.Relation<'manyToMany', 'admin::role'> &
      Schema.Attribute.Private;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    username: Schema.Attribute.String;
  };
}

export interface ApiAdClickAdClick extends Struct.CollectionTypeSchema {
  collectionName: 'ad_clicks';
  info: {
    displayName: 'AdClick';
    pluralName: 'ad-clicks';
    singularName: 'ad-click';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    adId: Schema.Attribute.String & Schema.Attribute.Required;
    createdAt: Schema.Attribute.DateTime;
    createdAtClient: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    email: Schema.Attribute.Email;
    eventType: Schema.Attribute.String & Schema.Attribute.DefaultTo<'click'>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::ad-click.ad-click'
    > &
      Schema.Attribute.Private;
    metadata: Schema.Attribute.JSON;
    ownerId: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiAdEventAdEvent extends Struct.CollectionTypeSchema {
  collectionName: 'ad_events';
  info: {
    displayName: 'AdEvent';
    pluralName: 'ad-events';
    singularName: 'ad-event';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    adId: Schema.Attribute.String & Schema.Attribute.Required;
    createdAt: Schema.Attribute.DateTime;
    createdAtClient: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    email: Schema.Attribute.Email;
    eventType: Schema.Attribute.String & Schema.Attribute.Required;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::ad-event.ad-event'
    > &
      Schema.Attribute.Private;
    metadata: Schema.Attribute.JSON;
    ownerId: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiAdAd extends Struct.CollectionTypeSchema {
  collectionName: 'ads';
  info: {
    displayName: 'Ad';
    pluralName: 'ads';
    singularName: 'ad';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    approvalStatus: Schema.Attribute.String;
    approved: Schema.Attribute.Boolean;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.Text;
    displayCount: Schema.Attribute.Integer;
    favoriteCount: Schema.Attribute.Integer;
    impressions: Schema.Attribute.Integer;
    isApproved: Schema.Attribute.Boolean;
    isPremiumOwner: Schema.Attribute.Boolean;
    izlenmeCount: Schema.Attribute.Integer;
    likeCount: Schema.Attribute.Integer;
    likes: Schema.Attribute.Integer;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::ad.ad'> &
      Schema.Attribute.Private;
    mediaType: Schema.Attribute.String;
    mediaUrl: Schema.Attribute.String;
    n8nUsed: Schema.Attribute.Boolean;
    ownerCity: Schema.Attribute.String;
    ownerName: Schema.Attribute.String;
    ownerProfileId: Schema.Attribute.String;
    prompt: Schema.Attribute.Text;
    publishDurationDays: Schema.Attribute.Integer;
    publishedAt: Schema.Attribute.DateTime;
    publishEndsAt: Schema.Attribute.DateTime;
    publishStartsAt: Schema.Attribute.DateTime;
    requestedAt: Schema.Attribute.DateTime;
    requestedByCity: Schema.Attribute.String;
    requestedByEmail: Schema.Attribute.String;
    requestedByName: Schema.Attribute.String;
    requestedByProfileId: Schema.Attribute.String;
    reviewStatus: Schema.Attribute.String;
    showCount: Schema.Attribute.Integer;
    smartAdsPlanDays: Schema.Attribute.Integer;
    smartAdsPlanTitle: Schema.Attribute.String;
    smartAdsPriceTl: Schema.Attribute.Integer;
    smartAdsTransactionId: Schema.Attribute.String;
    submitter: Schema.Attribute.String;
    title: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    videoViews: Schema.Attribute.Integer;
    viewCount: Schema.Attribute.Integer;
  };
}

export interface ApiAdminNotificationAdminNotification
  extends Struct.CollectionTypeSchema {
  collectionName: 'admin_notifications';
  info: {
    displayName: 'Admin Notification';
    pluralName: 'admin-notifications';
    singularName: 'admin-notification';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    audience: Schema.Attribute.Enumeration<['single', 'selected', 'all']> &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'single'>;
    category: Schema.Attribute.Enumeration<
      ['campaign', 'announcement', 'system']
    > &
      Schema.Attribute.DefaultTo<'announcement'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    deliveryStatus: Schema.Attribute.Enumeration<['queued', 'sent', 'failed']> &
      Schema.Attribute.DefaultTo<'queued'>;
    lastError: Schema.Attribute.Text;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::admin-notification.admin-notification'
    > &
      Schema.Attribute.Private;
    message: Schema.Attribute.Text & Schema.Attribute.Required;
    publishedAt: Schema.Attribute.DateTime;
    sentAt: Schema.Attribute.DateTime;
    sentCount: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    targetEmails: Schema.Attribute.JSON;
    targetProfileIds: Schema.Attribute.JSON;
    targetUser: Schema.Attribute.Relation<
      'oneToOne',
      'plugin::users-permissions.user'
    >;
    title: Schema.Attribute.String & Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiAgriPriceObservationAgriPriceObservation
  extends Struct.CollectionTypeSchema {
  collectionName: 'agri_price_observations';
  info: {
    description: 'Time-based agricultural price observations';
    displayName: 'Agri Price Observation';
    pluralName: 'agri-price-observations';
    singularName: 'agri-price-observation';
  };
  options: {
    draftAndPublish: true;
  };
  attributes: {
    averagePrice: Schema.Attribute.Decimal;
    changePercent: Schema.Attribute.Decimal;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    currency: Schema.Attribute.Enumeration<['TRY', 'USD', 'EUR']> &
      Schema.Attribute.DefaultTo<'TRY'>;
    isVerified: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::agri-price-observation.agri-price-observation'
    > &
      Schema.Attribute.Private;
    marketName: Schema.Attribute.String;
    maxPrice: Schema.Attribute.Decimal;
    minPrice: Schema.Attribute.Decimal;
    notes: Schema.Attribute.Text;
    observedAt: Schema.Attribute.DateTime;
    price: Schema.Attribute.Decimal;
    product: Schema.Attribute.Relation<
      'manyToOne',
      'api::agri-product.agri-product'
    >;
    province: Schema.Attribute.Relation<'manyToOne', 'api::province.province'>;
    publishedAt: Schema.Attribute.DateTime;
    sourceName: Schema.Attribute.String;
    sourceUrl: Schema.Attribute.String;
    unit: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiAgriProductAgriProduct extends Struct.CollectionTypeSchema {
  collectionName: 'agri_products';
  info: {
    description: 'Agricultural products tracked by the data center';
    displayName: 'Agri Product';
    pluralName: 'agri-products';
    singularName: 'agri-product';
  };
  options: {
    draftAndPublish: true;
  };
  attributes: {
    categoryName: Schema.Attribute.String;
    code: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    defaultUnit: Schema.Attribute.String;
    iconName: Schema.Attribute.String;
    image: Schema.Attribute.Media<'images'>;
    isActive: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::agri-product.agri-product'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    observations: Schema.Attribute.Relation<
      'oneToMany',
      'api::agri-price-observation.agri-price-observation'
    >;
    publishedAt: Schema.Attribute.DateTime;
    slug: Schema.Attribute.UID<'name'>;
    sortOrder: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiAiLogAiLog extends Struct.CollectionTypeSchema {
  collectionName: 'ai_logs';
  info: {
    displayName: 'AI Konusma Logu';
    pluralName: 'ai-logs';
    singularName: 'ai-log';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    answer: Schema.Attribute.RichText;
    confidenceLabel: Schema.Attribute.String;
    conversation: Schema.Attribute.RichText;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    hasImage: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::ai-log.ai-log'
    > &
      Schema.Attribute.Private;
    model: Schema.Attribute.String;
    ownerEmail: Schema.Attribute.Email;
    ownerProfileId: Schema.Attribute.String;
    prompt: Schema.Attribute.Text;
    provider: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    rawPrompt: Schema.Attribute.Text;
    recommendations: Schema.Attribute.JSON;
    scope: Schema.Attribute.String;
    suspectedIssue: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiDeletedAccountRecordDeletedAccountRecord
  extends Struct.CollectionTypeSchema {
  collectionName: 'deleted_account_records';
  info: {
    description: 'Kalici olarak silinen hesaplarin 15 gunluk yonetim kaydi';
    displayName: 'Silinen Hesaplar';
    pluralName: 'deleted-account-records';
    singularName: 'deleted-account-record';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    deletedAt: Schema.Attribute.DateTime & Schema.Attribute.Required;
    deletionSummary: Schema.Attribute.JSON;
    displayName: Schema.Attribute.String;
    email: Schema.Attribute.Email & Schema.Attribute.Required;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::deleted-account-record.deleted-account-record'
    > &
      Schema.Attribute.Private;
    ownerId: Schema.Attribute.String & Schema.Attribute.Required;
    publishedAt: Schema.Attribute.DateTime;
    purgeAt: Schema.Attribute.DateTime & Schema.Attribute.Required;
    retentionDays: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<15>;
    status: Schema.Attribute.Enumeration<['deleted', 'purged']> &
      Schema.Attribute.DefaultTo<'deleted'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    userId: Schema.Attribute.String;
    username: Schema.Attribute.String;
  };
}

export interface ApiHubBannerHubBanner extends Struct.CollectionTypeSchema {
  collectionName: 'hub_banners';
  info: {
    description: 'Managed hero banners for Knowledge Hub tabs';
    displayName: 'Hub Banner';
    pluralName: 'hub-banners';
    singularName: 'hub-banner';
  };
  options: {
    draftAndPublish: true;
  };
  attributes: {
    contentType: Schema.Attribute.Enumeration<['knowledge', 'agriData']>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    ctaLabel: Schema.Attribute.String;
    ctaUrl: Schema.Attribute.String;
    endsAt: Schema.Attribute.DateTime;
    eyebrow: Schema.Attribute.String;
    image: Schema.Attribute.Media<'images'>;
    isActive: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::hub-banner.hub-banner'
    > &
      Schema.Attribute.Private;
    mobileImage: Schema.Attribute.Media<'images'>;
    publishedAt: Schema.Attribute.DateTime;
    sortOrder: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    startsAt: Schema.Attribute.DateTime;
    subtitle: Schema.Attribute.Text;
    title: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiHubCategoryHubCategory extends Struct.CollectionTypeSchema {
  collectionName: 'hub_categories';
  info: {
    description: 'Categories used by Knowledge Hub content';
    displayName: 'Hub Category';
    pluralName: 'hub-categories';
    singularName: 'hub-category';
  };
  options: {
    draftAndPublish: true;
  };
  attributes: {
    colorHex: Schema.Attribute.String;
    contents: Schema.Attribute.Relation<
      'oneToMany',
      'api::hub-content.hub-content'
    >;
    contentType: Schema.Attribute.Enumeration<['knowledge', 'agriData']>;
    coverImage: Schema.Attribute.Media<'images'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.Text;
    iconName: Schema.Attribute.String;
    isActive: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::hub-category.hub-category'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    slug: Schema.Attribute.UID<'name'>;
    sortOrder: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiHubContentHubContent extends Struct.CollectionTypeSchema {
  collectionName: 'hub_contents';
  info: {
    displayName: 'HubContent';
    pluralName: 'hub-contents';
    singularName: 'hub-content';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    authorName: Schema.Attribute.String;
    body: Schema.Attribute.Text;
    category: Schema.Attribute.Relation<
      'manyToOne',
      'api::hub-category.hub-category'
    >;
    commentCount: Schema.Attribute.Integer;
    commentList: Schema.Attribute.JSON;
    comments: Schema.Attribute.Integer;
    content: Schema.Attribute.Text;
    createdAt: Schema.Attribute.DateTime;
    createdAtClient: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.Text;
    descShort: Schema.Attribute.Text;
    image: Schema.Attribute.Media<'images'>;
    imageUrl: Schema.Attribute.String;
    kind: Schema.Attribute.String;
    lastCommentAt: Schema.Attribute.DateTime;
    lastCommentAuthor: Schema.Attribute.String;
    lastCommentText: Schema.Attribute.Text;
    likes: Schema.Attribute.Integer;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::hub-content.hub-content'
    > &
      Schema.Attribute.Private;
    location: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    state: Schema.Attribute.String;
    title: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiListingViewListingView extends Struct.CollectionTypeSchema {
  collectionName: 'listing_views';
  info: {
    displayName: 'ListingView';
    pluralName: 'listing-views';
    singularName: 'listing-view';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    email: Schema.Attribute.Email;
    listingId: Schema.Attribute.String & Schema.Attribute.Required;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::listing-view.listing-view'
    > &
      Schema.Attribute.Private;
    metadata: Schema.Attribute.JSON;
    ownerId: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    viewedAt: Schema.Attribute.DateTime;
    viewerEmail: Schema.Attribute.Email;
    viewerProfileId: Schema.Attribute.String;
  };
}

export interface ApiListingListing extends Struct.CollectionTypeSchema {
  collectionName: 'listings';
  info: {
    displayName: 'Listing';
    pluralName: 'listings';
    singularName: 'listing';
  };
  options: {
    draftAndPublish: true;
  };
  attributes: {
    analysisNote: Schema.Attribute.Text;
    animalAge: Schema.Attribute.String;
    animalWeight: Schema.Attribute.String;
    certificateType: Schema.Attribute.String;
    city: Schema.Attribute.String;
    cityNormalized: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdAtClient: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    delivery: Schema.Attribute.String;
    demandAmount: Schema.Attribute.Decimal;
    description: Schema.Attribute.Text;
    district: Schema.Attribute.String;
    equipCondition: Schema.Attribute.String;
    equipModelYear: Schema.Attribute.Integer;
    equipWorkHour: Schema.Attribute.String;
    favoriteCount: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    hasatDate: Schema.Attribute.String;
    hasatYear: Schema.Attribute.Integer;
    isDoping: Schema.Attribute.Boolean;
    isPremium: Schema.Attribute.Boolean;
    isPremiumOwner: Schema.Attribute.Boolean;
    likeCount: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    listingNo: Schema.Attribute.Integer;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::listing.listing'
    > &
      Schema.Attribute.Private;
    location: Schema.Attribute.JSON;
    mainType: Schema.Attribute.String;
    maxBudget: Schema.Attribute.Decimal;
    minOrder: Schema.Attribute.Decimal;
    minOrderUnit: Schema.Attribute.String;
    mode: Schema.Attribute.Enumeration<['sell', 'buy']>;
    moisture: Schema.Attribute.Decimal;
    ownerCity: Schema.Attribute.String;
    ownerEmail: Schema.Attribute.Email;
    ownerId: Schema.Attribute.String;
    ownerName: Schema.Attribute.String;
    ownerProfileId: Schema.Attribute.String;
    packaging: Schema.Attribute.String;
    photos: Schema.Attribute.Media<'images', true>;
    price: Schema.Attribute.Decimal;
    priceUnit: Schema.Attribute.String;
    protein: Schema.Attribute.Decimal;
    publishedAt: Schema.Attribute.DateTime;
    qualityGrade: Schema.Attribute.String;
    rocketEndsAt: Schema.Attribute.DateTime;
    searchNormalized: Schema.Attribute.Text;
    status: Schema.Attribute.Enumeration<['pending', 'active', 'rejected']> &
      Schema.Attribute.DefaultTo<'active'>;
    storage: Schema.Attribute.String;
    subType: Schema.Attribute.String;
    title: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    viewCount: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
  };
}

export interface ApiLogisticsLoadLogisticsLoad
  extends Struct.CollectionTypeSchema {
  collectionName: 'logistics_loads';
  info: {
    description: 'Nakliye & Lojistik y\u00C3\u00BCk ilanlar\u00C4\u00B1';
    displayName: 'Logistics Load';
    pluralName: 'logistics-loads';
    singularName: 'logistics-load';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    adminNote: Schema.Attribute.Text;
    adminStatus: Schema.Attribute.String;
    adrClass: Schema.Attribute.String;
    budgetTry: Schema.Attribute.Decimal;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    dangerousGoods: Schema.Attribute.Boolean &
      Schema.Attribute.DefaultTo<false>;
    deliveryDate: Schema.Attribute.DateTime;
    description: Schema.Attribute.Text;
    dimensions: Schema.Attribute.String;
    estimatedDuration: Schema.Attribute.String;
    favoriteActorKeys: Schema.Attribute.JSON;
    favoriteCount: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    fromCity: Schema.Attribute.String & Schema.Attribute.Required;
    fromLatitude: Schema.Attribute.Decimal & Schema.Attribute.Required;
    fromLongitude: Schema.Attribute.Decimal & Schema.Attribute.Required;
    latitude: Schema.Attribute.Decimal & Schema.Attribute.Required;
    likeCount: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    likedActorKeys: Schema.Attribute.JSON;
    loadingDate: Schema.Attribute.DateTime & Schema.Attribute.Required;
    loadingMethod: Schema.Attribute.String;
    loadNo: Schema.Attribute.String & Schema.Attribute.Unique;
    loadType: Schema.Attribute.String & Schema.Attribute.Required;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::logistics-load.logistics-load'
    > &
      Schema.Attribute.Private;
    longitude: Schema.Attribute.Decimal & Schema.Attribute.Required;
    moderationNote: Schema.Attribute.Text;
    moderationStatus: Schema.Attribute.Enumeration<
      ['approved', 'pending', 'rejected']
    > &
      Schema.Attribute.DefaultTo<'pending'>;
    ownerKey: Schema.Attribute.String & Schema.Attribute.Required;
    ownerName: Schema.Attribute.String & Schema.Attribute.Required;
    ownerPhone: Schema.Attribute.String;
    ownerVerified: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    ownerWhatsapp: Schema.Attribute.String;
    packageCount: Schema.Attribute.Integer;
    packagingType: Schema.Attribute.String;
    paymentTerms: Schema.Attribute.String;
    photo: Schema.Attribute.Media<'images'>;
    publishedAt: Schema.Attribute.DateTime;
    shipmentType: Schema.Attribute.String;
    stackable: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    status: Schema.Attribute.Enumeration<
      ['open', 'offer_pending', 'meeting_opened', 'closed']
    > &
      Schema.Attribute.DefaultTo<'open'>;
    temperatureRange: Schema.Attribute.String;
    title: Schema.Attribute.String & Schema.Attribute.Required;
    toCity: Schema.Attribute.String & Schema.Attribute.Required;
    toLatitude: Schema.Attribute.Decimal & Schema.Attribute.Required;
    toLongitude: Schema.Attribute.Decimal & Schema.Attribute.Required;
    unloadingMethod: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    vehicleType: Schema.Attribute.String & Schema.Attribute.Required;
    viewCount: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    volumeM3: Schema.Attribute.Decimal;
    weight: Schema.Attribute.Decimal & Schema.Attribute.Required;
  };
}

export interface ApiLogisticsOfferLogisticsOffer
  extends Struct.CollectionTypeSchema {
  collectionName: 'logistics_offers';
  info: {
    description: 'Y\u00C3\u00BCkler i\u00C3\u00A7in verilen nakliye teklifleri';
    displayName: 'Logistics Offer';
    pluralName: 'logistics-offers';
    singularName: 'logistics-offer';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    adminIssueStatus: Schema.Attribute.String;
    adminNote: Schema.Attribute.Text;
    capacityLabel: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    estimatedTime: Schema.Attribute.String & Schema.Attribute.Required;
    issueStatus: Schema.Attribute.Enumeration<['none', 'flagged', 'resolved']> &
      Schema.Attribute.DefaultTo<'none'>;
    loadId: Schema.Attribute.String & Schema.Attribute.Required;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::logistics-offer.logistics-offer'
    > &
      Schema.Attribute.Private;
    meetingStatus: Schema.Attribute.String & Schema.Attribute.DefaultTo<''>;
    note: Schema.Attribute.Text;
    offerId: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    phone: Schema.Attribute.String;
    price: Schema.Attribute.Decimal & Schema.Attribute.Required;
    publishedAt: Schema.Attribute.DateTime;
    rating: Schema.Attribute.Decimal & Schema.Attribute.DefaultTo<4.5>;
    status: Schema.Attribute.Enumeration<['pending', 'accepted', 'rejected']> &
      Schema.Attribute.DefaultTo<'pending'>;
    transporterKey: Schema.Attribute.String & Schema.Attribute.Required;
    transporterName: Schema.Attribute.String & Schema.Attribute.Required;
    tripCount: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    vehicleType: Schema.Attribute.String & Schema.Attribute.Required;
    whatsapp: Schema.Attribute.String;
  };
}

export interface ApiLogisticsVehicleLogisticsVehicle
  extends Struct.CollectionTypeSchema {
  collectionName: 'logistics_vehicles';
  info: {
    description: 'Nakliyeci ara\u00C3\u00A7 profilleri';
    displayName: 'Logistics Vehicle';
    pluralName: 'logistics-vehicles';
    singularName: 'logistics-vehicle';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    adminNote: Schema.Attribute.Text;
    adminStatus: Schema.Attribute.String;
    available: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    capacity: Schema.Attribute.Decimal & Schema.Attribute.Required;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    currentCity: Schema.Attribute.String & Schema.Attribute.Required;
    description: Schema.Attribute.Text;
    destinationCities: Schema.Attribute.Text;
    latitude: Schema.Attribute.Decimal & Schema.Attribute.Required;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::logistics-vehicle.logistics-vehicle'
    > &
      Schema.Attribute.Private;
    longitude: Schema.Attribute.Decimal & Schema.Attribute.Required;
    moderationNote: Schema.Attribute.Text;
    moderationStatus: Schema.Attribute.Enumeration<
      ['approved', 'pending', 'rejected']
    > &
      Schema.Attribute.DefaultTo<'pending'>;
    phone: Schema.Attribute.String;
    photo: Schema.Attribute.Media<'images'>;
    publishedAt: Schema.Attribute.DateTime;
    rating: Schema.Attribute.Decimal & Schema.Attribute.DefaultTo<4.5>;
    serviceArea: Schema.Attribute.Text;
    sortOrder: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    transporterKey: Schema.Attribute.String & Schema.Attribute.Required;
    transporterName: Schema.Attribute.String & Schema.Attribute.Required;
    tripCount: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    vehicleNo: Schema.Attribute.String & Schema.Attribute.Unique;
    vehicleType: Schema.Attribute.String & Schema.Attribute.Required;
    whatsapp: Schema.Attribute.String;
  };
}

export interface ApiMessageMessage extends Struct.CollectionTypeSchema {
  collectionName: 'messages';
  info: {
    displayName: 'Message';
    pluralName: 'messages';
    singularName: 'message';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    contextId: Schema.Attribute.String;
    contextType: Schema.Attribute.Enumeration<
      ['general', 'listing', 'processed_product', 'logistics_load', 'support']
    > &
      Schema.Attribute.DefaultTo<'general'>;
    conversationKey: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    direction: Schema.Attribute.String;
    listingId: Schema.Attribute.String;
    listingNo: Schema.Attribute.Integer;
    listingTitle: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::message.message'
    > &
      Schema.Attribute.Private;
    message: Schema.Attribute.Text;
    messageReceiverEmail: Schema.Attribute.Email;
    messageReceiverProfileId: Schema.Attribute.String;
    metadata: Schema.Attribute.JSON;
    publishedAt: Schema.Attribute.DateTime;
    readAt: Schema.Attribute.DateTime;
    readBy: Schema.Attribute.JSON;
    receiverEmail: Schema.Attribute.String;
    receiverName: Schema.Attribute.String;
    receiverProfileId: Schema.Attribute.String;
    requesterEmail: Schema.Attribute.String;
    requesterName: Schema.Attribute.String;
    requesterProfileId: Schema.Attribute.String;
    senderEmail: Schema.Attribute.String;
    senderName: Schema.Attribute.String;
    senderProfileId: Schema.Attribute.String;
    sentAt: Schema.Attribute.DateTime;
    targetEmail: Schema.Attribute.Email;
    targetProfileId: Schema.Attribute.String;
    text: Schema.Attribute.Text;
    threadId: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiNotificationNotification
  extends Struct.CollectionTypeSchema {
  collectionName: 'notifications';
  info: {
    displayName: 'Notification';
    pluralName: 'notifications';
    singularName: 'notification';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    answerId: Schema.Attribute.String;
    audience: Schema.Attribute.String;
    broadcast: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    createdAt: Schema.Attribute.DateTime;
    createdAtClient: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    event: Schema.Attribute.String;
    isBroadcast: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    isRead: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    kind: Schema.Attribute.String;
    listingId: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::notification.notification'
    > &
      Schema.Attribute.Private;
    message: Schema.Attribute.Text;
    notificationId: Schema.Attribute.String;
    offerId: Schema.Attribute.String;
    ownerProfileId: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    pushError: Schema.Attribute.Text;
    pushStatus: Schema.Attribute.String;
    questionId: Schema.Attribute.String;
    readAt: Schema.Attribute.DateTime;
    receiverEmail: Schema.Attribute.String;
    receiverProfileId: Schema.Attribute.String;
    recipientEmail: Schema.Attribute.String;
    recipientProfileId: Schema.Attribute.String;
    requesterEmail: Schema.Attribute.String;
    requesterProfileId: Schema.Attribute.String;
    senderEmail: Schema.Attribute.String;
    senderProfileId: Schema.Attribute.String;
    sentAt: Schema.Attribute.DateTime;
    skipPush: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    source: Schema.Attribute.String;
    targetAll: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    targetAudience: Schema.Attribute.String;
    targetEmail: Schema.Attribute.String;
    targetProfileId: Schema.Attribute.String;
    threadId: Schema.Attribute.String;
    title: Schema.Attribute.String;
    type: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedAtClient: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiOfferOffer extends Struct.CollectionTypeSchema {
  collectionName: 'offers';
  info: {
    displayName: 'Offer';
    pluralName: 'offers';
    singularName: 'offer';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    approved: Schema.Attribute.Boolean;
    createdAt: Schema.Attribute.DateTime;
    createdAtClient: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    direction: Schema.Attribute.String;
    imageUrl: Schema.Attribute.String;
    isIncoming: Schema.Attribute.Boolean;
    listingId: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::offer.offer'> &
      Schema.Attribute.Private;
    note: Schema.Attribute.Text;
    offerId: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    offerStatus: Schema.Attribute.String;
    ownerAvatarUrl: Schema.Attribute.String;
    ownerCity: Schema.Attribute.String;
    ownerName: Schema.Attribute.String;
    priceText: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    qtyText: Schema.Attribute.String;
    receiverCity: Schema.Attribute.String;
    receiverEmail: Schema.Attribute.String;
    receiverName: Schema.Attribute.String;
    receiverProfileId: Schema.Attribute.String;
    requesterCity: Schema.Attribute.String;
    requesterEmail: Schema.Attribute.String;
    requesterName: Schema.Attribute.String;
    requesterProfileId: Schema.Attribute.String;
    seenAt: Schema.Attribute.DateTime;
    seenBy: Schema.Attribute.JSON;
    title: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedAtClient: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiProcessedProductCategoryProcessedProductCategory
  extends Struct.CollectionTypeSchema {
  collectionName: 'processed_product_categories';
  info: {
    displayName: 'Processed Product Category';
    pluralName: 'processed-product-categories';
    singularName: 'processed-product-category';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.Text;
    isActive: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::processed-product-category.processed-product-category'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    publishedAt: Schema.Attribute.DateTime;
    slug: Schema.Attribute.UID<'name'>;
    sortOrder: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiProcessedProductProcessedProduct
  extends Struct.CollectionTypeSchema {
  collectionName: 'processed_products';
  info: {
    displayName: 'Processed Product';
    pluralName: 'processed-products';
    singularName: 'processed-product';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    category: Schema.Attribute.String & Schema.Attribute.Required;
    city: Schema.Attribute.String;
    cover: Schema.Attribute.Media<'images'>;
    coverPath: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    isActive: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::processed-product.processed-product'
    > &
      Schema.Attribute.Private;
    localProductId: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    moderationNote: Schema.Attribute.Text;
    moderationStatus: Schema.Attribute.Enumeration<
      ['approved', 'pending', 'rejected']
    > &
      Schema.Attribute.DefaultTo<'approved'>;
    ownerEmail: Schema.Attribute.Email;
    ownerId: Schema.Attribute.String & Schema.Attribute.Required;
    packageText: Schema.Attribute.String;
    priceText: Schema.Attribute.String;
    productNo: Schema.Attribute.String & Schema.Attribute.Unique;
    publishedAt: Schema.Attribute.DateTime;
    shortDescription: Schema.Attribute.Text;
    sortOrder: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    stockText: Schema.Attribute.String;
    store: Schema.Attribute.Relation<
      'manyToOne',
      'api::seller-store.seller-store'
    > &
      Schema.Attribute.Required;
    storeName: Schema.Attribute.String;
    storeSlug: Schema.Attribute.String;
    title: Schema.Attribute.String & Schema.Attribute.Required;
    unitText: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiProfileSettingProfileSetting
  extends Struct.CollectionTypeSchema {
  collectionName: 'profile_settings';
  info: {
    displayName: 'ProfileSetting';
    pluralName: 'profile-settings';
    singularName: 'profile-setting';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    aboutText: Schema.Attribute.Text;
    accountType: Schema.Attribute.Enumeration<
      ['standard', 'premium', 'business']
    > &
      Schema.Attribute.DefaultTo<'standard'>;
    activeModules: Schema.Attribute.JSON;
    activePremium: Schema.Attribute.JSON;
    activePremiumSubscription: Schema.Attribute.JSON;
    avatarImage: Schema.Attribute.Media<'images' | 'files'>;
    avatarUrl: Schema.Attribute.String;
    bio: Schema.Attribute.Text;
    birthDate: Schema.Attribute.Date;
    brandName: Schema.Attribute.String;
    businessModules: Schema.Attribute.JSON;
    businessModulesUpdatedAt: Schema.Attribute.DateTime;
    city: Schema.Attribute.String;
    contactPhoneVisible: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    contactWhatsappVisible: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    coverImage: Schema.Attribute.Media<'images' | 'files'>;
    coverUrl: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    disabledBusinessModules: Schema.Attribute.JSON;
    displayName: Schema.Attribute.String;
    district: Schema.Attribute.String;
    favoriteListingIds: Schema.Attribute.JSON;
    favoriteProfiles: Schema.Attribute.JSON;
    favoriteProfilesMap: Schema.Attribute.JSON;
    favoriteProfilesUpdatedAt: Schema.Attribute.DateTime;
    favoritesListingIds: Schema.Attribute.JSON;
    favoritesUpdatedAt: Schema.Attribute.DateTime;
    fcmTokens: Schema.Attribute.JSON;
    featuredListingIds: Schema.Attribute.JSON;
    followerIds: Schema.Attribute.JSON;
    followers: Schema.Attribute.JSON;
    followersCountBase: Schema.Attribute.Integer;
    followersFallback: Schema.Attribute.Integer;
    followersIds: Schema.Attribute.JSON;
    following: Schema.Attribute.JSON;
    followingCountBase: Schema.Attribute.Integer;
    followingFallback: Schema.Attribute.Integer;
    followingIds: Schema.Attribute.JSON;
    followsIds: Schema.Attribute.JSON;
    followUpdatedAt: Schema.Attribute.DateTime;
    incomingComments: Schema.Attribute.JSON;
    incomingCommentsUpdatedAt: Schema.Attribute.DateTime;
    incomingProfileComments: Schema.Attribute.JSON;
    lastSeenAt: Schema.Attribute.DateTime;
    likedFarmerQuestionIds: Schema.Attribute.JSON;
    likedFarmerQuestionIdsUpdatedAt: Schema.Attribute.DateTime;
    likedListingIds: Schema.Attribute.JSON;
    likedListingIdsUpdatedAt: Schema.Attribute.DateTime;
    likedLogisticsLoadIds: Schema.Attribute.JSON;
    likedLogisticsLoadIdsUpdatedAt: Schema.Attribute.DateTime;
    likedProductIds: Schema.Attribute.JSON;
    likedProductIdsUpdatedAt: Schema.Attribute.DateTime;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::profile-setting.profile-setting'
    > &
      Schema.Attribute.Private;
    logisticsAboutText: Schema.Attribute.Text;
    logisticsVehicleRockets: Schema.Attribute.JSON;
    logisticsVehicleRocketsUpdatedAt: Schema.Attribute.DateTime;
    myCommentItems: Schema.Attribute.JSON;
    myComments: Schema.Attribute.JSON;
    myCommentsUpdatedAt: Schema.Attribute.DateTime;
    ownerEmail: Schema.Attribute.Email;
    phone: Schema.Attribute.String;
    processedProductRockets: Schema.Attribute.JSON;
    processedProductRocketsUpdatedAt: Schema.Attribute.DateTime;
    profileId: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    profileMediaSettings: Schema.Attribute.JSON;
    publicUsername: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    purchaseHistory: Schema.Attribute.JSON;
    purchaseRecords: Schema.Attribute.JSON;
    purchaseUpdatedAt: Schema.Attribute.DateTime;
    ratingAverageBase: Schema.Attribute.Decimal;
    ratingBaseAverage: Schema.Attribute.Decimal;
    ratingBaseCount: Schema.Attribute.Integer;
    ratingUpdatedAt: Schema.Attribute.DateTime;
    ratingVotes: Schema.Attribute.JSON;
    ratingVotesByViewer: Schema.Attribute.JSON;
    roleText: Schema.Attribute.String;
    settings: Schema.Attribute.JSON;
    showcasePinnedIds: Schema.Attribute.JSON;
    showcasePinnedOrder: Schema.Attribute.Text;
    updatedAt: Schema.Attribute.DateTime;
    updatedAtClient: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    user: Schema.Attribute.Relation<
      'oneToOne',
      'plugin::users-permissions.user'
    >;
    voteCountBase: Schema.Attribute.Integer;
    whatsapp: Schema.Attribute.String;
  };
}

export interface ApiProfileViewProfileView extends Struct.CollectionTypeSchema {
  collectionName: 'profile_views';
  info: {
    displayName: 'ProfileView';
    pluralName: 'profile-views';
    singularName: 'profile-view';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::profile-view.profile-view'
    > &
      Schema.Attribute.Private;
    metadata: Schema.Attribute.JSON;
    profileId: Schema.Attribute.String & Schema.Attribute.Required;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    viewedAt: Schema.Attribute.DateTime;
    viewerEmail: Schema.Attribute.Email;
    viewerOwnerId: Schema.Attribute.String;
  };
}

export interface ApiPromoCodePromoCode extends Struct.CollectionTypeSchema {
  collectionName: 'promo_codes';
  info: {
    displayName: 'Promo Code';
    pluralName: 'promo-codes';
    singularName: 'promo-code';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    adminNote: Schema.Attribute.Text;
    allowWhenPremiumActive: Schema.Attribute.Boolean &
      Schema.Attribute.DefaultTo<false>;
    code: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    codeNormalized: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.Text;
    endsAt: Schema.Attribute.DateTime;
    grantMessage: Schema.Attribute.Text;
    isActive: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    lastRedeemedAt: Schema.Attribute.DateTime;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::promo-code.promo-code'
    > &
      Schema.Attribute.Private;
    perUserLimit: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<1>;
    premiumProductId: Schema.Attribute.Enumeration<
      [
        'premium_easy_yearly_999',
        'premium_eco_yearly_1599',
        'premium_pro_yearly_3599',
      ]
    > &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'premium_easy_yearly_999'>;
    publishedAt: Schema.Attribute.DateTime;
    redemptionCount: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    startsAt: Schema.Attribute.DateTime;
    targetUser: Schema.Attribute.Relation<
      'oneToOne',
      'plugin::users-permissions.user'
    >;
    title: Schema.Attribute.String & Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    usageLimit: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<1>;
  };
}

export interface ApiPromoRedemptionPromoRedemption
  extends Struct.CollectionTypeSchema {
  collectionName: 'promo_redemptions';
  info: {
    displayName: 'Promo Redemption';
    pluralName: 'promo-redemptions';
    singularName: 'promo-redemption';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    grantedDurationDays: Schema.Attribute.Integer & Schema.Attribute.Required;
    grantedPlanTitle: Schema.Attribute.String & Schema.Attribute.Required;
    grantedProductId: Schema.Attribute.String & Schema.Attribute.Required;
    grantSnapshot: Schema.Attribute.JSON;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::promo-redemption.promo-redemption'
    > &
      Schema.Attribute.Private;
    ownerProfileId: Schema.Attribute.String & Schema.Attribute.Required;
    promoCode: Schema.Attribute.Relation<
      'manyToOne',
      'api::promo-code.promo-code'
    >;
    publishedAt: Schema.Attribute.DateTime;
    redeemedAt: Schema.Attribute.DateTime & Schema.Attribute.Required;
    redeemedCode: Schema.Attribute.String & Schema.Attribute.Required;
    status: Schema.Attribute.Enumeration<['redeemed']> &
      Schema.Attribute.DefaultTo<'redeemed'>;
    transactionId: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    user: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    userEmail: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface ApiProvinceProvince extends Struct.CollectionTypeSchema {
  collectionName: 'provinces';
  info: {
    description: 'Provinces used for regional agricultural data';
    displayName: 'Province';
    pluralName: 'provinces';
    singularName: 'province';
  };
  options: {
    draftAndPublish: true;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    isActive: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    latitude: Schema.Attribute.Decimal;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::province.province'
    > &
      Schema.Attribute.Private;
    longitude: Schema.Attribute.Decimal;
    name: Schema.Attribute.String;
    observations: Schema.Attribute.Relation<
      'oneToMany',
      'api::agri-price-observation.agri-price-observation'
    >;
    plateCode: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    regionName: Schema.Attribute.String;
    slug: Schema.Attribute.UID<'name'>;
    sortOrder: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiPurchaseEventPurchaseEvent
  extends Struct.CollectionTypeSchema {
  collectionName: 'purchase_events';
  info: {
    displayName: 'PurchaseEvent';
    pluralName: 'purchase-events';
    singularName: 'purchase-event';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    categoryTitle: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    expiresAt: Schema.Attribute.DateTime;
    isSubscription: Schema.Attribute.Boolean;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::purchase-event.purchase-event'
    > &
      Schema.Attribute.Private;
    originalTransactionId: Schema.Attribute.String;
    ownerEmail: Schema.Attribute.String;
    ownerProfileId: Schema.Attribute.String & Schema.Attribute.Required;
    payload: Schema.Attribute.JSON;
    planTitle: Schema.Attribute.String;
    priceTl: Schema.Attribute.Integer;
    productId: Schema.Attribute.String & Schema.Attribute.Required;
    provider: Schema.Attribute.String & Schema.Attribute.Required;
    publishedAt: Schema.Attribute.DateTime;
    purchaseToken: Schema.Attribute.String;
    source: Schema.Attribute.String;
    status: Schema.Attribute.Enumeration<
      ['verified', 'pending', 'canceled', 'refunded', 'expired', 'rejected']
    > &
      Schema.Attribute.DefaultTo<'pending'>;
    transactionId: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    verifiedAt: Schema.Attribute.DateTime;
  };
}

export interface ApiRegistrationBlockRegistrationBlock
  extends Struct.CollectionTypeSchema {
  collectionName: 'registration_blocks';
  info: {
    displayName: 'Registration Block';
    pluralName: 'registration-blocks';
    singularName: 'registration-block';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    adminNote: Schema.Attribute.Text;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    email: Schema.Attribute.String;
    emailDomain: Schema.Attribute.String;
    isActive: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::registration-block.registration-block'
    > &
      Schema.Attribute.Private;
    phone: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    reasonCode: Schema.Attribute.Enumeration<
      ['fraud-risk', 'abuse', 'duplicate', 'policy', 'other']
    > &
      Schema.Attribute.DefaultTo<'other'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    userMessage: Schema.Attribute.Text;
  };
}

export interface ApiSellerPayoutSellerPayout
  extends Struct.CollectionTypeSchema {
  collectionName: 'seller_payouts';
  info: {
    displayName: 'Seller Payout';
    pluralName: 'seller-payouts';
    singularName: 'seller-payout';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    commissionAmount: Schema.Attribute.Decimal;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::seller-payout.seller-payout'
    > &
      Schema.Attribute.Private;
    note: Schema.Attribute.Text;
    orderId: Schema.Attribute.String;
    paidAt: Schema.Attribute.DateTime;
    publishedAt: Schema.Attribute.DateTime;
    sellerEarning: Schema.Attribute.Decimal;
    sellerId: Schema.Attribute.String;
    status: Schema.Attribute.Enumeration<
      ['pending', 'ready', 'paid', 'blocked']
    > &
      Schema.Attribute.DefaultTo<'pending'>;
    totalAmount: Schema.Attribute.Decimal;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiSellerStoreSellerStore extends Struct.CollectionTypeSchema {
  collectionName: 'seller_stores';
  info: {
    displayName: 'Seller Store';
    pluralName: 'seller-stores';
    singularName: 'seller-store';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    aboutText: Schema.Attribute.RichText;
    city: Schema.Attribute.String & Schema.Attribute.Required;
    contactName: Schema.Attribute.String & Schema.Attribute.Required;
    coverPath: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    documents: Schema.Attribute.Relation<
      'oneToMany',
      'api::store-document.store-document'
    >;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::seller-store.seller-store'
    > &
      Schema.Attribute.Private;
    logoPath: Schema.Attribute.String;
    ownerEmail: Schema.Attribute.Email;
    ownerId: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    products: Schema.Attribute.Relation<
      'oneToMany',
      'api::processed-product.processed-product'
    >;
    publishedAt: Schema.Attribute.DateTime;
    shortDescription: Schema.Attribute.Text & Schema.Attribute.Required;
    storeName: Schema.Attribute.String & Schema.Attribute.Required;
    storeSlug: Schema.Attribute.UID<'storeName'> & Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    verificationNote: Schema.Attribute.Text;
    verificationStatus: Schema.Attribute.Enumeration<
      ['not_submitted', 'pending', 'approved', 'rejected']
    > &
      Schema.Attribute.DefaultTo<'not_submitted'>;
  };
}

export interface ApiStoreDocumentStoreDocument
  extends Struct.CollectionTypeSchema {
  collectionName: 'store_documents';
  info: {
    displayName: 'Store Document';
    pluralName: 'store-documents';
    singularName: 'store-document';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    documentType: Schema.Attribute.Enumeration<
      [
        'tax_certificate',
        'business_license',
        'production_certificate',
        'identity_document',
        'other',
      ]
    > &
      Schema.Attribute.Required;
    file: Schema.Attribute.Media<'images' | 'files'>;
    filePath: Schema.Attribute.String;
    localDocumentId: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::store-document.store-document'
    > &
      Schema.Attribute.Private;
    ownerEmail: Schema.Attribute.Email;
    ownerId: Schema.Attribute.String & Schema.Attribute.Required;
    publishedAt: Schema.Attribute.DateTime;
    reviewNote: Schema.Attribute.Text;
    store: Schema.Attribute.Relation<
      'manyToOne',
      'api::seller-store.seller-store'
    > &
      Schema.Attribute.Required;
    title: Schema.Attribute.String & Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    verificationStatus: Schema.Attribute.Enumeration<
      ['pending', 'approved', 'rejected']
    > &
      Schema.Attribute.DefaultTo<'pending'>;
  };
}

export interface ApiSupportTicketMessageSupportTicketMessage
  extends Struct.CollectionTypeSchema {
  collectionName: 'support_ticket_messages';
  info: {
    displayName: 'Support Ticket Message';
    pluralName: 'support-ticket-messages';
    singularName: 'support-ticket-message';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdAtClient: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::support-ticket-message.support-ticket-message'
    > &
      Schema.Attribute.Private;
    message: Schema.Attribute.Text;
    publishedAt: Schema.Attribute.DateTime;
    receiverEmail: Schema.Attribute.String;
    receiverProfileId: Schema.Attribute.String;
    requesterEmail: Schema.Attribute.String;
    requesterProfileId: Schema.Attribute.String;
    senderEmail: Schema.Attribute.String;
    senderName: Schema.Attribute.String;
    senderProfileId: Schema.Attribute.String;
    senderType: Schema.Attribute.String;
    sentAt: Schema.Attribute.DateTime;
    supportTicket: Schema.Attribute.Relation<
      'manyToOne',
      'api::support-ticket.support-ticket'
    >;
    supportTicketId: Schema.Attribute.String;
    text: Schema.Attribute.Text;
    ticketId: Schema.Attribute.String;
    ticketNo: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiSupportTicketSupportTicket
  extends Struct.CollectionTypeSchema {
  collectionName: 'support_tickets';
  info: {
    displayName: 'Support Ticket';
    pluralName: 'support-tickets';
    singularName: 'support-ticket';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    category: Schema.Attribute.String;
    conversation: Schema.Attribute.Text;
    createdAt: Schema.Attribute.DateTime;
    createdAtClient: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    lastMessageAt: Schema.Attribute.DateTime;
    lastMessagePreview: Schema.Attribute.Text;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::support-ticket.support-ticket'
    > &
      Schema.Attribute.Private;
    messages: Schema.Attribute.Relation<
      'oneToMany',
      'api::support-ticket-message.support-ticket-message'
    >;
    ownerEmail: Schema.Attribute.String;
    ownerName: Schema.Attribute.String;
    ownerProfileId: Schema.Attribute.String;
    priority: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    status: Schema.Attribute.String;
    subject: Schema.Attribute.String;
    ticketNo: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiThreadThread extends Struct.CollectionTypeSchema {
  collectionName: 'threads';
  info: {
    displayName: 'Thread';
    pluralName: 'threads';
    singularName: 'thread';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    contextId: Schema.Attribute.String;
    contextType: Schema.Attribute.Enumeration<
      ['general', 'listing', 'processed_product', 'logistics_load', 'support']
    > &
      Schema.Attribute.DefaultTo<'general'>;
    conversationKey: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    imageUrl: Schema.Attribute.String;
    lastMessage: Schema.Attribute.Text;
    lastMessageAt: Schema.Attribute.DateTime;
    lastMessageMe: Schema.Attribute.Boolean;
    lastMessagePreview: Schema.Attribute.Text;
    lastReadAt: Schema.Attribute.DateTime;
    lastSenderEmail: Schema.Attribute.String;
    lastSenderProfileId: Schema.Attribute.String;
    lastTimeText: Schema.Attribute.String;
    listingId: Schema.Attribute.String;
    listingMode: Schema.Attribute.Enumeration<['sell', 'buy']>;
    listingNo: Schema.Attribute.Integer;
    listingPriceText: Schema.Attribute.String;
    listingQtyText: Schema.Attribute.String;
    listingTitle: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::thread.thread'
    > &
      Schema.Attribute.Private;
    metadata: Schema.Attribute.JSON;
    personAvatarUrl: Schema.Attribute.String;
    personCity: Schema.Attribute.String;
    personName: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    readReceipts: Schema.Attribute.JSON;
    receiverEmail: Schema.Attribute.String;
    receiverName: Schema.Attribute.String;
    receiverProfileId: Schema.Attribute.String;
    requesterEmail: Schema.Attribute.String;
    requesterName: Schema.Attribute.String;
    requesterProfileId: Schema.Attribute.String;
    threadId: Schema.Attribute.String & Schema.Attribute.Unique;
    unreadCount: Schema.Attribute.Integer;
    updatedAt: Schema.Attribute.DateTime;
    updatedAtClient: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginContentReleasesRelease
  extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_releases';
  info: {
    displayName: 'Release';
    pluralName: 'releases';
    singularName: 'release';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    actions: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::content-releases.release-action'
    >;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::content-releases.release'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    publishedAt: Schema.Attribute.DateTime;
    releasedAt: Schema.Attribute.DateTime;
    scheduledAt: Schema.Attribute.DateTime;
    status: Schema.Attribute.Enumeration<
      ['ready', 'blocked', 'failed', 'done', 'empty']
    > &
      Schema.Attribute.Required;
    timezone: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginContentReleasesReleaseAction
  extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_release_actions';
  info: {
    displayName: 'Release Action';
    pluralName: 'release-actions';
    singularName: 'release-action';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    contentType: Schema.Attribute.String & Schema.Attribute.Required;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    entryDocumentId: Schema.Attribute.String;
    isEntryValid: Schema.Attribute.Boolean;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::content-releases.release-action'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    release: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::content-releases.release'
    >;
    type: Schema.Attribute.Enumeration<['publish', 'unpublish']> &
      Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginI18NLocale extends Struct.CollectionTypeSchema {
  collectionName: 'i18n_locale';
  info: {
    collectionName: 'locales';
    description: '';
    displayName: 'Locale';
    pluralName: 'locales';
    singularName: 'locale';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    code: Schema.Attribute.String & Schema.Attribute.Unique;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::i18n.locale'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.SetMinMax<
        {
          max: 50;
          min: 1;
        },
        number
      >;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginReviewWorkflowsWorkflow
  extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_workflows';
  info: {
    description: '';
    displayName: 'Workflow';
    name: 'Workflow';
    pluralName: 'workflows';
    singularName: 'workflow';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    contentTypes: Schema.Attribute.JSON &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'[]'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::review-workflows.workflow'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    publishedAt: Schema.Attribute.DateTime;
    stageRequiredToPublish: Schema.Attribute.Relation<
      'oneToOne',
      'plugin::review-workflows.workflow-stage'
    >;
    stages: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::review-workflows.workflow-stage'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginReviewWorkflowsWorkflowStage
  extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_workflows_stages';
  info: {
    description: '';
    displayName: 'Stages';
    name: 'Workflow Stage';
    pluralName: 'workflow-stages';
    singularName: 'workflow-stage';
  };
  options: {
    draftAndPublish: false;
    version: '1.1.0';
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    color: Schema.Attribute.String & Schema.Attribute.DefaultTo<'#4945FF'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::review-workflows.workflow-stage'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    permissions: Schema.Attribute.Relation<'manyToMany', 'admin::permission'>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    workflow: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::review-workflows.workflow'
    >;
  };
}

export interface PluginUploadFile extends Struct.CollectionTypeSchema {
  collectionName: 'files';
  info: {
    description: '';
    displayName: 'File';
    pluralName: 'files';
    singularName: 'file';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    alternativeText: Schema.Attribute.Text;
    caption: Schema.Attribute.Text;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    ext: Schema.Attribute.String;
    focalPoint: Schema.Attribute.JSON;
    folder: Schema.Attribute.Relation<'manyToOne', 'plugin::upload.folder'> &
      Schema.Attribute.Private;
    folderPath: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Private &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    formats: Schema.Attribute.JSON;
    hash: Schema.Attribute.String & Schema.Attribute.Required;
    height: Schema.Attribute.Integer;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::upload.file'
    > &
      Schema.Attribute.Private;
    mime: Schema.Attribute.String & Schema.Attribute.Required;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    previewUrl: Schema.Attribute.Text;
    provider: Schema.Attribute.String & Schema.Attribute.Required;
    provider_metadata: Schema.Attribute.JSON;
    publishedAt: Schema.Attribute.DateTime;
    related: Schema.Attribute.Relation<'morphToMany'>;
    size: Schema.Attribute.Decimal & Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    url: Schema.Attribute.Text & Schema.Attribute.Required;
    width: Schema.Attribute.Integer;
  };
}

export interface PluginUploadFolder extends Struct.CollectionTypeSchema {
  collectionName: 'upload_folders';
  info: {
    displayName: 'Folder';
    pluralName: 'folders';
    singularName: 'folder';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    children: Schema.Attribute.Relation<'oneToMany', 'plugin::upload.folder'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    files: Schema.Attribute.Relation<'oneToMany', 'plugin::upload.file'>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::upload.folder'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    parent: Schema.Attribute.Relation<'manyToOne', 'plugin::upload.folder'>;
    path: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    pathId: Schema.Attribute.Integer &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginUsersPermissionsPermission
  extends Struct.CollectionTypeSchema {
  collectionName: 'up_permissions';
  info: {
    description: '';
    displayName: 'Permission';
    name: 'permission';
    pluralName: 'permissions';
    singularName: 'permission';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    action: Schema.Attribute.String & Schema.Attribute.Required;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::users-permissions.permission'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    role: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.role'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginUsersPermissionsRole
  extends Struct.CollectionTypeSchema {
  collectionName: 'up_roles';
  info: {
    description: '';
    displayName: 'Role';
    name: 'role';
    pluralName: 'roles';
    singularName: 'role';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::users-permissions.role'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 3;
      }>;
    permissions: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::users-permissions.permission'
    >;
    publishedAt: Schema.Attribute.DateTime;
    type: Schema.Attribute.String & Schema.Attribute.Unique;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    users: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::users-permissions.user'
    >;
  };
}

export interface PluginUsersPermissionsUser
  extends Struct.CollectionTypeSchema {
  collectionName: 'up_users';
  info: {
    description: '';
    displayName: 'User';
    name: 'user';
    pluralName: 'users';
    singularName: 'user';
  };
  options: {
    draftAndPublish: false;
    timestamps: true;
  };
  attributes: {
    blocked: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    confirmationToken: Schema.Attribute.String & Schema.Attribute.Private;
    confirmed: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    email: Schema.Attribute.Email &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 6;
      }>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::users-permissions.user'
    > &
      Schema.Attribute.Private;
    password: Schema.Attribute.Password &
      Schema.Attribute.Private &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 6;
      }>;
    provider: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    resetPasswordToken: Schema.Attribute.String & Schema.Attribute.Private;
    role: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.role'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    username: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 3;
      }>;
  };
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ContentTypeSchemas {
      'admin::api-token': AdminApiToken;
      'admin::api-token-permission': AdminApiTokenPermission;
      'admin::permission': AdminPermission;
      'admin::role': AdminRole;
      'admin::session': AdminSession;
      'admin::transfer-token': AdminTransferToken;
      'admin::transfer-token-permission': AdminTransferTokenPermission;
      'admin::user': AdminUser;
      'api::ad-click.ad-click': ApiAdClickAdClick;
      'api::ad-event.ad-event': ApiAdEventAdEvent;
      'api::ad.ad': ApiAdAd;
      'api::admin-notification.admin-notification': ApiAdminNotificationAdminNotification;
      'api::agri-price-observation.agri-price-observation': ApiAgriPriceObservationAgriPriceObservation;
      'api::agri-product.agri-product': ApiAgriProductAgriProduct;
      'api::ai-log.ai-log': ApiAiLogAiLog;
      'api::deleted-account-record.deleted-account-record': ApiDeletedAccountRecordDeletedAccountRecord;
      'api::hub-banner.hub-banner': ApiHubBannerHubBanner;
      'api::hub-category.hub-category': ApiHubCategoryHubCategory;
      'api::hub-content.hub-content': ApiHubContentHubContent;
      'api::listing-view.listing-view': ApiListingViewListingView;
      'api::listing.listing': ApiListingListing;
      'api::logistics-load.logistics-load': ApiLogisticsLoadLogisticsLoad;
      'api::logistics-offer.logistics-offer': ApiLogisticsOfferLogisticsOffer;
      'api::logistics-vehicle.logistics-vehicle': ApiLogisticsVehicleLogisticsVehicle;
      'api::message.message': ApiMessageMessage;
      'api::notification.notification': ApiNotificationNotification;
      'api::offer.offer': ApiOfferOffer;
      'api::processed-product-category.processed-product-category': ApiProcessedProductCategoryProcessedProductCategory;
      'api::processed-product.processed-product': ApiProcessedProductProcessedProduct;
      'api::profile-setting.profile-setting': ApiProfileSettingProfileSetting;
      'api::profile-view.profile-view': ApiProfileViewProfileView;
      'api::promo-code.promo-code': ApiPromoCodePromoCode;
      'api::promo-redemption.promo-redemption': ApiPromoRedemptionPromoRedemption;
      'api::province.province': ApiProvinceProvince;
      'api::purchase-event.purchase-event': ApiPurchaseEventPurchaseEvent;
      'api::registration-block.registration-block': ApiRegistrationBlockRegistrationBlock;
      'api::seller-payout.seller-payout': ApiSellerPayoutSellerPayout;
      'api::seller-store.seller-store': ApiSellerStoreSellerStore;
      'api::store-document.store-document': ApiStoreDocumentStoreDocument;
      'api::support-ticket-message.support-ticket-message': ApiSupportTicketMessageSupportTicketMessage;
      'api::support-ticket.support-ticket': ApiSupportTicketSupportTicket;
      'api::thread.thread': ApiThreadThread;
      'plugin::content-releases.release': PluginContentReleasesRelease;
      'plugin::content-releases.release-action': PluginContentReleasesReleaseAction;
      'plugin::i18n.locale': PluginI18NLocale;
      'plugin::review-workflows.workflow': PluginReviewWorkflowsWorkflow;
      'plugin::review-workflows.workflow-stage': PluginReviewWorkflowsWorkflowStage;
      'plugin::upload.file': PluginUploadFile;
      'plugin::upload.folder': PluginUploadFolder;
      'plugin::users-permissions.permission': PluginUsersPermissionsPermission;
      'plugin::users-permissions.role': PluginUsersPermissionsRole;
      'plugin::users-permissions.user': PluginUsersPermissionsUser;
    }
  }
}
