/**
 * Ana sayfa "arama butonu" Instagram-gibi davranış düzeltmesi: profil
 * sonuçları önceden Flutter tarafında SADECE o an yüklü ilanların
 * sahiplerinden türetiliyordu (search_listings_page.dart'ın eski
 * _profileCandidates'ı) -- hiç ilanı olmayan (veya ilanı henüz yerel
 * cache'e düşmemiş) kayıtlı bir kullanıcı isim aramasında asla çıkmazdı.
 * Bu servis gerçek bir "isme göre profil ara" kaynağı: profile-setting
 * tablosundaki HERKESE AÇIK alanlardan arar, public-profile.ts'in zaten
 * denetlenmiş allowlist mantığıyla aynı -- email/telefon/ham PII asla
 * döndürülmez. global::profile-setting-ownership politikasına hiç
 * girmez (bu da public-profile.ts ile aynı, kasıtlı tasarım: o politika
 * tek-profil sahiplik kontrolü için var, herkese açık bir dizin
 * aramasıyla ilgisi yok).
 *
 * Eşleştirme stratejisi: Postgres (production) ve SQLite (yerel/test)
 * arasında ortak, DB-bağımsız bir "Türkçe karakter katla + içerir" arama
 * -- listing-search-fields.ts'teki normalizeTurkishText ile AYNI
 * normalizasyon kullanılır (ör. "çiftçi"/"ciftci"/"CIFTCI" hepsi aynı
 * sonucu bulur), ayrı bir normalize fonksiyonu icat edilmedi. Profil
 * tablosuna kalıcı bir "searchNormalized" kolonu eklemek (listing'deki
 * gibi) şimdilik atlandı -- bunun için her yazma yoluna (profil
 * düzenleme, iş ortaklığı senkronizasyonu, vb.) bir lifecycle hook
 * eklemek gerekirdi; bu da mevcut, test edilmiş yazma akışlarına
 * dokunma riski taşır. Bunun yerine sorgu anında makul bir üst sınırla
 * (MAX_SCAN_ROWS) satırlar çekilip bellekte normalize edilerek
 * karşılaştırılıyor -- bu uygulamanın şu anki kullanıcı ölçeğinde
 * (henüz on binlerce profil yok) ucuz ve güvenli; tablo büyürse bu
 * sınırı/stratejiyi yeniden değerlendirmek gerekir.
 */
import { TARGET_UID } from '../../../utils/engagement-contract';
import { normalizeTurkishText } from '../../../utils/listing-search-fields';
import { isPremiumActiveFromProfile } from '../../../utils/premium-sync';

const PROFILE_UID = TARGET_UID.profile;

const MAX_SCAN_ROWS = 1000;
const MAX_RESULTS = 60;

const SELECT_FIELDS = [
  'profileId',
  'displayName',
  'publicUsername',
  'brandName',
  'city',
  'accountType',
  'activePremium',
  'activePremiumSubscription',
  'updatedAt',
] as const;

const MEDIA_POPULATE = { avatarImage: true } as any;

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

const mediaUrl = (media: unknown): string => {
  if (!media || typeof media !== 'object') return '';
  return str((media as Record<string, unknown>).url);
};

export interface PublicProfileSearchHit {
  ownerId: string;
  displayName: string;
  publicUsername: string;
  brandName: string;
  city: string;
  avatarUrl: string;
  isPremium: boolean;
}

export const searchPublicProfiles = async (
  strapiInstance: any,
  rawQuery: string,
): Promise<PublicProfileSearchHit[]> => {
  const normalizedQuery = normalizeTurkishText(rawQuery);
  const tokens = normalizedQuery.split(' ').filter((t) => t.length > 0);
  if (tokens.length === 0) return [];

  const rows = await strapiInstance.db.query(PROFILE_UID).findMany({
    select: [...SELECT_FIELDS],
    populate: MEDIA_POPULATE,
    orderBy: { updatedAt: 'desc' },
    limit: MAX_SCAN_ROWS,
  });

  const hits: PublicProfileSearchHit[] = [];
  for (const row of rows ?? []) {
    const profileId = str(row.profileId);
    if (!profileId) continue;
    const displayName = str(row.displayName);
    const publicUsername = str(row.publicUsername);
    const brandName = str(row.brandName);
    const city = str(row.city);
    const haystack = normalizeTurkishText(
      [displayName, publicUsername, brandName, city].join(' '),
    );
    if (!tokens.every((t) => haystack.includes(t))) continue;

    hits.push({
      ownerId: profileId,
      displayName,
      publicUsername,
      brandName,
      city,
      avatarUrl: mediaUrl(row.avatarImage),
      isPremium: isPremiumActiveFromProfile(row),
    });
  }

  hits.sort((a, b) => {
    if (a.isPremium !== b.isPremium) return a.isPremium ? -1 : 1;
    return normalizeTurkishText(a.displayName).localeCompare(normalizeTurkishText(b.displayName));
  });

  return hits.slice(0, MAX_RESULTS);
};
