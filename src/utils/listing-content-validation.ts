/**
 * ILAN OLUSTURMA RAPORU ROUND 2: create_listing_page.dart's own Form
 * validators (title >=3 chars, description >=12 chars, sell price >0, buy
 * demandAmount >0, at least 1 photo) were never mirrored server-side --
 * confirmed live (listing-az-report-round2-targeted.integration.test.ts)
 * that a direct POST /listings request bypassing the Flutter form could
 * create an empty-title, 2-character-description, negative-price,
 * negative-demandAmount, zero-photo listing. Shared here so listing.ts's
 * create()/update() and engagement.ts's syncOfflineListing (the
 * offline-queue create/update path) enforce the exact same rules
 * identically -- the same cross-path-consistency reasoning
 * LISTING_CLIENT_PROTECTED_FIELDS/MAX_LISTING_PHOTOS already use.
 *
 * Deliberately mirrors ONLY the rules the Flutter form already enforces --
 * no new business rule is introduced here. Every category-specific field
 * (moisture/protein/animalAge/equipPower/equipModelYear/minOrder/etc.) is an
 * optional "if entered, must be a valid format" field in the Flutter form --
 * none of them is ever actually required for any category, so none of them
 * is added here.
 */

export const MIN_LISTING_TITLE_LENGTH = 3;
export const MIN_LISTING_DESCRIPTION_LENGTH = 12;
export const MIN_LISTING_PHOTOS = 1;

export const validateListingTitle = (value: unknown): string | null => {
  const title = typeof value === 'string' ? value.trim() : '';
  if (title.length < MIN_LISTING_TITLE_LENGTH) {
    return `Ilan basligi en az ${MIN_LISTING_TITLE_LENGTH} karakter olmali.`;
  }
  return null;
};

export const validateListingDescription = (value: unknown): string | null => {
  const description = typeof value === 'string' ? value.trim() : '';
  if (description.length < MIN_LISTING_DESCRIPTION_LENGTH) {
    return `Aciklama en az ${MIN_LISTING_DESCRIPTION_LENGTH} karakter olmali.`;
  }
  return null;
};

export const validateListingModeValue = (value: unknown): string | null => {
  const mode = typeof value === 'string' ? value.trim() : '';
  if (mode !== 'sell' && mode !== 'buy') {
    return 'Ilan modu sell veya buy olmali.';
  }
  return null;
};

/**
 * Only applies when `mode` resolves to 'sell' -- a buy-mode listing's price
 * is legitimately absent, this is not a universal "price must be valid"
 * rule.
 */
export const validateListingPriceForMode = (mode: unknown, price: unknown): string | null => {
  if (mode !== 'sell') return null;
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) {
    return 'Satis ilaninda gecerli bir fiyat girilmeli.';
  }
  return null;
};

/** Mirror of validateListingPriceForMode for the 'buy' side. */
export const validateListingDemandAmountForMode = (mode: unknown, demandAmount: unknown): string | null => {
  if (mode !== 'buy') return null;
  const n = Number(demandAmount);
  if (!Number.isFinite(n) || n <= 0) {
    return 'Alim ilaninda gecerli bir miktar girilmeli.';
  }
  return null;
};

export const validateMinListingPhotoCount = (distinctPhotoCount: number): string | null => {
  if (distinctPhotoCount < MIN_LISTING_PHOTOS) {
    return `En az ${MIN_LISTING_PHOTOS} fotograf eklenmelidir.`;
  }
  return null;
};
