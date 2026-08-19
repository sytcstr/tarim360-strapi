const LISTING_UID = 'api::listing.listing';
const AD_UID = 'api::ad.ad';
const PROFILE_UID = 'api::profile-setting.profile-setting';

const normalizeText = (value: unknown): string => String(value ?? '').trim();

const parseDate = (value: unknown): Date | null => {
  const raw = normalizeText(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const pickPremiumPayload = (row: Record<string, unknown> | null | undefined) => {
  if (!row || typeof row !== 'object') return null;
  const direct = (row.activePremium ?? row.activePremiumSubscription ?? null) as
    | Record<string, unknown>
    | null;
  if (direct && typeof direct === 'object') return direct;
  return null;
};

export const isPremiumActiveFromProfile = (
  row: Record<string, unknown> | null | undefined,
): boolean => {
  const premium = pickPremiumPayload(row);
  if (!premium) return false;
  const endsAt = parseDate(premium.endsAt);
  if (!endsAt) return true;
  return endsAt.getTime() > Date.now();
};

const updateCollectionPremiumFlags = async (
  strapiRef: any,
  uid: string,
  profileId: string,
  isPremium: boolean,
) => {
  const isListing = uid === LISTING_UID;
  const where = isListing
    ? {
        $or: [{ ownerProfileId: profileId }, { ownerId: profileId }],
      }
    : {
        $or: [{ ownerProfileId: profileId }],
      };

  const select = isListing
    ? (['id', 'isPremium', 'isPremiumOwner'] as const)
    : (['id', 'isPremiumOwner'] as const);

  const rows = await strapiRef.db.query(uid).findMany({
    where,
    select,
  } as any);

  for (const row of Array.isArray(rows) ? rows : []) {
    const id = Number((row as any)?.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const currentPremiumOwner = (row as any)?.isPremiumOwner === true;
    if (isListing) {
      const currentPremium = (row as any)?.isPremium === true;
      if (currentPremium === isPremium && currentPremiumOwner === isPremium) {
        continue;
      }

      await strapiRef.entityService.update(uid as any, id as any, {
        data: {
          isPremium,
          isPremiumOwner: isPremium,
        },
      });
      continue;
    }

    if (currentPremiumOwner === isPremium) continue;
    await strapiRef.entityService.update(uid as any, id as any, {
      data: {
        isPremiumOwner: isPremium,
      },
    });
  }
};

/**
 * PREMIUM_P1_TARGETED_FIX_REPORT.md: the same profile-setting lookup
 * listing.ts's create()/update() already do inline (findProfileForIdentity),
 * shared here so every server-authoritative premium gate loads the row the
 * same way instead of each controller growing its own copy. Selects only
 * what isPremiumActiveFromProfile (and callers reading rocket/smartAd
 * counters off the same payload) need.
 */
export const loadPremiumProfile = async (
  strapiRef: any,
  identity: { email: string; ownerId: string },
): Promise<Record<string, unknown> | null> => {
  const rows = await strapiRef.entityService.findMany(PROFILE_UID as any, {
    filters: {
      $or: [{ profileId: identity.ownerId }, { ownerEmail: identity.email }],
    },
    fields: ['id', 'profileId', 'ownerEmail', 'activePremium', 'activePremiumSubscription'],
    limit: 1,
  } as any);
  const row = Array.isArray(rows) ? rows[0] : rows;
  return (row as Record<string, unknown> | undefined) ?? null;
};

export const syncOwnerPremiumFlags = async (
  strapiRef: any,
  profileRow: Record<string, unknown> | null | undefined,
) => {
  const profileId = normalizeText(profileRow?.profileId);
  if (!profileId) return;

  const isPremium = isPremiumActiveFromProfile(profileRow);
  await updateCollectionPremiumFlags(strapiRef, LISTING_UID, profileId, isPremium);
  await updateCollectionPremiumFlags(strapiRef, AD_UID, profileId, isPremium);
};
