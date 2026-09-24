import type { Core } from '@strapi/strapi';

const LISTING_UID = 'api::listing.listing';
const FIELD = 'listingStatus';

/**
 * Makes the `listingStatus` moderation field visible in the Content Manager
 * for the Listing type: first row of the edit view + a list-view column.
 *
 * Why this is needed: Strapi stores each content type's admin layout in the
 * database, and a deploy does NOT reliably add a newly introduced attribute
 * to a layout that was already saved -- in production the stored Listing edit
 * view ends at its last pre-existing field and `listingStatus` was never
 * added, so admins could not reach the field (the status -> listingStatus
 * migration fixed the API/schema but not this stored layout). Doing it here
 * means it happens on the next boot of every environment instead of relying
 * on someone finding "Insert another field" in the admin panel.
 *
 * Safety:
 *  - Only ADDS the field where it is missing; every other field, size, row,
 *    label and setting is preserved exactly as stored.
 *  - Runs once (app-store flag, set only after success) so it never fights an
 *    admin who later deliberately rearranges or hides the field.
 *  - Touches admin UI configuration only -- never listing data.
 *  - A failure is logged and retried on the next boot; it must never take the
 *    API down over a cosmetic admin setting.
 */
export const ensureListingStatusInContentManagerLayoutOnce = async (
  strapi: Core.Strapi,
) => {
  const appStore = strapi.store({ type: 'core', name: 'bootstrap' });
  const key = 'listing_status_cm_layout_v1_done';
  try {
    if ((await appStore.get({ key })) === true) {
      strapi.log.info('Listing status Content Manager layout skipped (already done).');
      return;
    }

    const contentType = strapi.contentType(LISTING_UID);
    const cm = strapi.plugin('content-manager').service('content-types');
    const conf = await cm.findConfiguration(contentType);
    const layouts = conf?.layouts ?? {};
    const edit: Array<Array<{ name: string; size: number }>> = layouts.edit ?? [];
    const list: string[] = layouts.list ?? [];

    const inEdit = edit.some((row) => row.some((f) => f.name === FIELD));
    const inList = list.includes(FIELD);
    const metadatas = { ...(conf?.metadatas ?? {}) };
    const meta = metadatas[FIELD];
    const metaOk = !!meta && meta.edit?.visible !== false && meta.edit?.editable !== false;

    if (inEdit && inList && metaOk) {
      await appStore.set({ key, value: true });
      strapi.log.info('Listing status Content Manager layout already complete.');
      return;
    }

    metadatas[FIELD] = {
      ...(meta ?? {}),
      edit: {
        label: 'listingStatus',
        description: '',
        placeholder: '',
        ...(meta?.edit ?? {}),
        visible: true,
        editable: true,
      },
      list: {
        label: 'listingStatus',
        searchable: true,
        sortable: true,
        ...(meta?.list ?? {}),
      },
    };

    const newEdit = inEdit ? edit : [[{ name: FIELD, size: 6 }], ...edit];
    let newList = list;
    if (!inList) {
      const titleAt = list.indexOf('title');
      newList = [...list.slice(0, titleAt + 1), FIELD, ...list.slice(titleAt + 1)];
    }

    await cm.updateConfiguration(contentType, {
      settings: conf.settings,
      metadatas,
      layouts: { ...layouts, edit: newEdit, list: newList },
    });

    await appStore.set({ key, value: true });
    strapi.log.info(
      `Listing status Content Manager layout updated (edit view: ${inEdit ? 'kept' : 'added as first row'}, list view: ${inList ? 'kept' : 'column added'}).`,
    );
  } catch (e) {
    strapi.log.error(`Listing status Content Manager layout NOT updated (will retry next boot): ${e}`);
  }
};
