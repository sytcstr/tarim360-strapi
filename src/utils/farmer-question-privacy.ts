import type { Core } from '@strapi/strapi';
import {
  isDeletedOrHiddenState,
  isFarmerQuestionCommentKind,
  isFarmerQuestionKind,
  isFarmerQuestionReportKind,
  isOwnerAlsoHiddenFarmerQuestionState,
  matchesIdentity,
  resolveActorProfile,
  type SessionIdentity,
} from './identity';

/**
 * Soru/Profil/Kart denetimi (2026-10-25), Çiftçi Sorulari maddeler 1-4 --
 * ve bu dosyanın ikinci round'u, aynı dört maddenin açık kalan yolları.
 *
 * Madde 1 (liste gizlilik + profil kaynaklı görünen kimlik): `find` hiçbir
 * zaman `findOne`'ın zaten uyguladığı "non-owner + hidden/deleted/
 * archived/blocked/draft/unpublished -> görünmez" kuralını uygulamıyordu.
 * `applyFarmerQuestionReadGuards`, findOne'ın ZATEN KULLANDIĞI aynı
 * generic kontrolü `find`'ın satır listesine de uyguluyor -- yeni bir
 * kural değil, var olan korumanın ikinci okuma yoluna genişletilmesi.
 * Ayrıca (round 2) bir sorunun/şikayetin GÖRÜNEN adı/şehri/avatarı artık
 * `stampFarmerIdentityIntoBody` ile gerçek, doğrulanmış profile-setting
 * satırından türetiliyor -- istemcinin "ben X kişisiyim" diye gösterdiği
 * değerler asla kabul edilmiyor. Profil yoksa (yeni hesap) güvenli,
 * kendinden türetilmiş bir fallback kullanılır (email'in @ öncesi kısmı
 * gibi) -- ASLA başka bir kimliğe geçilmez.
 *
 * Madde 2 (e-posta sızıntısı, create+update birlikte): `body` TÜM
 * hub-content kind'larının paylaştığı serbest bir text alanı olduğu için
 * (blog da kendi verisini aynı alanda tutar), e-postayı şemadan `private`
 * yapmak mümkün değil -- bu TÜM kind'ları etkilerdi. Bunun yerine
 * SADECE çiftçi-sorusu ailesi (soru/cevap/şikayet) için `body`'nin JSON'u
 * ayrıştırılıp e-posta alanları satırın SAHİBİ OLMAYAN her çağıran için
 * çıkarılıyor. `stampFarmerIdentityIntoBody` artık create() VE update()
 * ikisinde de çağrılıyor -- bir satırın sahibi kendi PUT/PATCH'iyle kendi
 * görünen kimliğini başka bir gerçek kişiye çeviremez. Gömülü
 * `answers[]` dizisine KASITLI OLARAK dokunulmuyor (ne stampte ne
 * sanitizede) -- eski cevapların gerçek yazarları hiçbir zaman soru
 * sahibine dönüştürülmez.
 *
 * Madde 3 (yazar-başına e-posta izolasyonu): bir önceki round'un gözden
 * kaçırdığı kısım -- bir SORU satırının sahibi (soruyu soran kişi),
 * SADECE o satırın sahibi olduğu için gömülü `answers[]` içindeki HER
 * cevaplayanın e-postasını görmemeli. `sanitizeFarmerBodyText` artık
 * gömülü her cevabı KENDİ yazarının kimliğine göre ayrı ayrı
 * değerlendiriyor (email/profileId eşleşmesi) -- satırın üst-seviye
 * sahipliğinden bağımsız. Üst-seviye authorEmail/email/reporterEmail hâlâ
 * satırın gerçek sahibine (soru->soran, cevap->cevaplayan, şikayet->
 * şikayetçi) göre kontrol ediliyor, çünkü o alanlar HER ZAMAN satırın
 * kendi sahibine ait.
 *
 * Madde 4 (sayfalama öncesi filtre): bu dosyanın gizlilik/e-posta
 * sanitizasyonu hâlâ post-hoc (super.find() sonrası) çalışıyor, ama
 * GÖRÜNÜRLÜK filtresi (hangi satırlar hiç dönecek) artık
 * `hub-content.ts`'in find() override'ında QUERY SEVİYESİNDE
 * uygulanıyor (bkz. o dosyadaki `buildFarmerVisibilityFilter` kullanımı)
 * -- Strapi'nin kendi sayfalama/toplam hesaplaması ZATEN filtrelenmiş
 * veri kümesi üzerinde çalışıyor, bu yüzden post-hoc adım artık normal
 * akışta hiçbir satırı kaldırmıyor (sadece savunma amaçlı, bkz. aşağıda).
 */

/**
 * Kapanış kontrolü (2026-10-25): profil yoksa güvenli, kimlik sızdırmayan
 * tek fallback adı. Flutter'ın kendi `authorName.isEmpty ? 'Kullanıcı' :
 * authorName` deseniyle aynı metin -- hem soru/şikayet damgalaması
 * (stampFarmerIdentityIntoBody) hem cevap damgalaması
 * (hub-content.ts'in addFarmerQuestionAnswer'ı) bu TEK sabiti kullanır,
 * ikisinin de ayrı ayrı email'den isim türetmesini önler.
 */
export const FARMER_IDENTITY_FALLBACK_NAME = 'Kullanıcı';

const isFarmerQuestionFamilyKind = (rawKind: unknown): boolean =>
  isFarmerQuestionKind(rawKind) || isFarmerQuestionCommentKind(rawKind) || isFarmerQuestionReportKind(rawKind);

const isRowOwner = (row: Record<string, unknown>, identity: SessionIdentity | null): boolean =>
  !!identity && matchesIdentity(row, identity, ['ownerEmail'], ['ownerProfileId']);

const normalizeForCompare = (value: unknown): string => String(value ?? '').trim().toLowerCase();

/**
 * Madde 5: exported for reuse by hub-content.ts's `deleteFarmerQuestionAnswer`
 * action -- the same "does this embedded answer entry belong to this
 * identity" check this file already uses for read-time email isolation
 * (Madde 3) is also exactly the authorization check a dedicated answer
 * deletion endpoint needs for the legacy-embedded-answer case.
 */
export const embeddedAnswerBelongsToIdentity = (entry: any, identity: SessionIdentity | null): boolean => {
  if (!identity || !entry || typeof entry !== 'object') return false;
  const entryEmail = normalizeForCompare(entry.email);
  const entryProfileId = String(entry.profileId ?? '').trim();
  return (!!entryEmail && entryEmail === identity.email) || (!!entryProfileId && entryProfileId === identity.ownerId);
};

/**
 * Madde 2 (satırın kendi üst-seviye email alanı) + Madde 3 (gömülü
 * answers[] dizisindeki her bir cevabın kendi email alanı, kendi
 * yazarına göre, ayrı ayrı).
 */
const sanitizeFarmerBodyText = (
  bodyText: unknown,
  rowOwnedByViewer: boolean,
  identity: SessionIdentity | null,
): unknown => {
  if (typeof bodyText !== 'string' || !bodyText.trim()) return bodyText;
  let parsed: any;
  try {
    parsed = JSON.parse(bodyText);
  } catch (_) {
    return bodyText;
  }
  if (!parsed || typeof parsed !== 'object') return bodyText;
  let changed = false;

  if (!rowOwnedByViewer) {
    for (const key of ['authorEmail', 'email', 'reporterEmail']) {
      if (key in parsed) {
        delete parsed[key];
        changed = true;
      }
    }
  }

  if (Array.isArray(parsed.answers)) {
    parsed.answers = parsed.answers.map((entry: any) => {
      if (
        entry &&
        typeof entry === 'object' &&
        'email' in entry &&
        !embeddedAnswerBelongsToIdentity(entry, identity)
      ) {
        changed = true;
        const { email: _omit, ...rest } = entry;
        return rest;
      }
      return entry;
    });
  }

  if (!changed) return bodyText;
  return JSON.stringify(parsed);
};

const applyRowGuards = (row: any, identity: SessionIdentity | null): any | null => {
  if (!row || typeof row !== 'object') return row;
  const isOwner = isRowOwner(row, identity);
  // Madde 1 -- defense in depth; hub-content.ts's find() already excludes
  // these at the query level (Madde 4), and findOne() already returns
  // notFound before this ever runs, so this branch is not expected to
  // fire in the normal flow, but stays as a safety net against a future
  // query-building change that forgets the visibility filter.
  //
  // Madde 10-11 (kapanış): mirrors hub-content.ts's own findOne() rule --
  // the owner's unconditional bypass is preserved for every hidden state
  // (block/hidden/draft/unpublish/etc.) and narrowed ONLY for a
  // farmerQuestion-family row whose state is the old, ambiguous plain
  // 'archived' marker or the new 'farmerQuestionDeleted' soft-delete
  // marker.
  if (isDeletedOrHiddenState(row)) {
    const ownerBypass =
      isOwner &&
      (!isFarmerQuestionFamilyKind(row.kind) ||
        !isOwnerAlsoHiddenFarmerQuestionState(row));
    if (!ownerBypass) return null;
  }
  // Madde 2 + Madde 3 -- runs regardless of row ownership now, since
  // embedded answers[] need per-entry evaluation even when the viewer
  // DOES own the parent question row.
  if (isFarmerQuestionFamilyKind(row.kind)) {
    const sanitizedBody = sanitizeFarmerBodyText(row.body, isOwner, identity);
    if (sanitizedBody !== row.body) {
      return { ...row, body: sanitizedBody };
    }
  }
  return row;
};

/**
 * Madde 4: the hidden/deleted/archived/blocked/draft/unpublished rule
 * `findOne` already enforced (and `find` now also enforces) must be
 * applied BEFORE Strapi computes pagination/totals, never by fetching a
 * page then discarding rows from it afterward -- a post-hoc filter would
 * silently shrink a page below its requested size, report a `total`/
 * `pageCount` that counts rows the caller can never actually see (an
 * indirect "how much hidden content exists" signal), and could skip rows
 * entirely across page boundaries. Expressed as a real Strapi filter
 * (same `$notContainsi`/`$null` operators already used elsewhere in this
 * codebase -- see conversation.ts/listing-popular-query.ts/
 * listing-status-backfill.ts) so the Query Engine excludes these rows
 * before `limit`/`start`/`count` are ever computed. Kind-agnostic, same
 * as the rest of this file's Madde 1 rule -- applies identically to
 * blog/Knowledge Hub content sharing this table.
 */
const NOT_HIDDEN_STATE_FILTER = {
  $or: [
    { state: { $null: true } },
    {
      $and: [
        { state: { $notContainsi: 'delete' } },
        { state: { $notContainsi: 'archive' } },
        { state: { $notContainsi: 'block' } },
        { state: { $notContainsi: 'remove' } },
        { state: { $notContainsi: 'hidden' } },
        { state: { $notContainsi: 'draft' } },
        { state: { $notContainsi: 'unpublish' } },
      ],
    },
  ],
};

/**
 * Soru/Profil/Kart denetimi Madde 10-11 (kapanış, düzeltme): the owner's
 * unconditional bypass below is preserved for every hidden state
 * (block/hidden/draft/unpublish/etc.) and narrowed ONLY for a
 * farmerQuestion-family row that is [isOwnerAlsoHiddenFarmerQuestionState]
 * -- state:'deleted', or state:'archived' TOGETHER WITH deleted:true/
 * isDeleted:true (the genuinely ambiguous old shape). A bare
 * state:'archived' row with neither flag true is NOT denied here --
 * never for any other hidden state, and never for a non-farmer kind
 * (blog/Knowledge Hub), which keeps its original, unconditional owner
 * bypass untouched. This is the De Morgan expansion of
 * `!isOwnerAlsoHiddenFarmerQuestionState(row)`, expressed as a real
 * Strapi query filter (same operators as NOT_HIDDEN_STATE_FILTER above)
 * so it runs at the query level, not a post-hoc JS predicate. A plain
 * `kind` substring check (not the full isFarmerQuestionFamilyKind
 * normalization) is enough here: it only needs to be safely
 * OVER-inclusive (never under-inclusive).
 */
const NOT_FARMER_QUESTION_FAMILY_KIND_FILTER = {
  kind: { $notContainsi: 'farmer' },
};

const NOT_OWNER_ALSO_HIDDEN_FARMER_QUESTION_STATE_FILTER = {
  $and: [
    { state: { $ne: 'deleted' } },
    {
      $or: [
        { state: { $ne: 'archived' } },
        { $and: [{ deleted: { $ne: true } }, { isDeleted: { $ne: true } }] },
      ],
    },
  ],
};

export const buildHubContentVisibilityFilter = (identity: SessionIdentity | null): Record<string, unknown> => {
  if (!identity) return NOT_HIDDEN_STATE_FILTER;
  const ownedByMe = {
    $or: [
      { ownerEmail: { $eq: identity.email } },
      { ownerProfileId: { $eq: identity.ownerId } },
    ],
  };
  return {
    $or: [
      NOT_HIDDEN_STATE_FILTER,
      {
        $and: [
          ownedByMe,
          {
            $or: [
              NOT_FARMER_QUESTION_FAMILY_KIND_FILTER,
              NOT_OWNER_ALSO_HIDDEN_FARMER_QUESTION_STATE_FILTER,
              NOT_HIDDEN_STATE_FILTER,
            ],
          },
        ],
      },
    ],
  };
};

/** Accepts a row, an array of rows, or a `{ data }` envelope of either --
 * the same shape `find`/`findOne`'s core action returns. */
export const applyFarmerQuestionReadGuards = (payload: any, identity: SessionIdentity | null): any => {
  if (Array.isArray(payload)) {
    const out: any[] = [];
    for (const row of payload) {
      const guarded = applyRowGuards(row, identity);
      if (guarded !== null) out.push(guarded);
    }
    return out;
  }
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return { ...payload, data: applyFarmerQuestionReadGuards(payload.data, identity) };
  }
  const guarded = applyRowGuards(payload, identity);
  return guarded === null ? payload : guarded;
};

/**
 * Madde 1 (round 2) + Madde 3/4 (kimlik taklidi, create VE update): bir
 * sorunun/şikayetin GÖRÜNEN kimliği (authorEmail/authorProfileId/
 * authorName/authorCity/authorAvatarUrl; reporterEmail/reporterProfileId/
 * reporterName/reporterCity) artık tamamen istemciden değil, gerçek
 * oturumdan VE o oturumun kendi doğrulanmış profile-setting satırından
 * türetiliyor. Profil yoksa (yeni hesap), `resolveActorProfile`'ın kendi
 * güvenli, KENDİNDEN türetilmiş fallback'i kullanılıyor (email'in @
 * öncesi kısmı + varsayılan şehir) -- hiçbir koşulda başka bir kimliğe
 * düşülmüyor. Yalnız bu iki kind'ın bilinen body şeklini damgalar;
 * herhangi bir başka kind'ın body'sine (blog dahil) dokunmaz. Gömülü
 * `answers[]` dizisine KASITLI OLARAK dokunmaz -- bu fonksiyon yalnız
 * sorunun/şikayetin KENDİ üst-seviye alanlarını damgalar; çağıran
 * update() akışı bunu her çağrıda yeniden uyguladığında bile eski
 * cevapların kendi yazar bilgisi asla ezilmez.
 */
export const stampFarmerIdentityIntoBody = async (
  strapi: Core.Strapi,
  rawKind: unknown,
  bodyText: unknown,
  identity: SessionIdentity,
): Promise<unknown> => {
  if (typeof bodyText !== 'string' || !bodyText.trim()) return bodyText;
  let parsed: any;
  try {
    parsed = JSON.parse(bodyText);
  } catch (_) {
    return bodyText;
  }
  if (!parsed || typeof parsed !== 'object') return bodyText;

  // Kapanış kontrolü (2026-10-25): email'in @ öncesi kısmı fallback adı
  // olarak kullanılırsa, e-postanın bir parçası yine herkese açık
  // "görünen ad" olarak sızar (çoğu kullanıcı adının @ öncesi kısmı
  // gerçek adını/soyadını içerir). Profil yoksa genel "Kullanıcı"
  // etiketi kullanılıyor -- Flutter'ın kendi `authorName.isEmpty ?
  // 'Kullanıcı' : authorName` fallback'iyle aynı, email'den hiçbir parça
  // taşımıyor.
  const fallbackName = FARMER_IDENTITY_FALLBACK_NAME;
  if (isFarmerQuestionKind(rawKind)) {
    const profile = await resolveActorProfile(strapi, identity.ownerId, { name: fallbackName, city: 'Türkiye' });
    parsed.authorEmail = identity.email;
    parsed.authorProfileId = identity.ownerId;
    parsed.authorName = profile.name;
    parsed.authorCity = profile.city;
    parsed.authorAvatarUrl = profile.avatarUrl;
  } else if (isFarmerQuestionReportKind(rawKind)) {
    const profile = await resolveActorProfile(strapi, identity.ownerId, { name: fallbackName, city: 'Türkiye' });
    parsed.reporterEmail = identity.email;
    parsed.reporterProfileId = identity.ownerId;
    parsed.reporterName = profile.name;
    parsed.reporterCity = profile.city;
  } else {
    return bodyText;
  }
  return JSON.stringify(parsed);
};
