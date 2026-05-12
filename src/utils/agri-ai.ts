const asString = (value: unknown): string => String(value ?? '').trim();

const asInt = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
};

const OPENAI_API_KEY = asString(process.env.OPENAI_API_KEY);
const OPENAI_BASE_URL =
  asString(process.env.OPENAI_BASE_URL) || 'https://api.openai.com/v1';
const OPENAI_MODEL = asString(process.env.OPENAI_MODEL) || 'gpt-4o-mini';
const OPENAI_VISION_MODEL =
  asString(process.env.OPENAI_VISION_MODEL) || OPENAI_MODEL;
const AI_TIMEOUT_MS = Math.max(
  10000,
  asInt(process.env.AGRI_AI_TIMEOUT_MS, 35000),
);

export type AgriAiInput = {
  prompt: string;
  scope: string;
  imageBase64?: string;
  fileName?: string;
  forceRulesOnly?: boolean;
  rawPrompt?: string;
};

export type AgriAiResult = {
  answer: string;
  recommendations: string[];
  suspectedIssue?: string;
  confidenceLabel: string;
  provider: string;
  scope: string;
};

const parseJsonObject = (raw: string): Record<string, unknown> | null => {
  const text = asString(raw);
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (_) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch (_) {
      return null;
    }
  }
};

const asStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => asString(row))
    .filter((row) => row.length > 0)
    .slice(0, 6);
};

const normalizeScope = (value: unknown): string => {
  const raw = asString(value).toLowerCase();
  if (!raw) return 'agriculture';
  return raw;
};

const normalizeForMatch = (value: unknown): string =>
  asString(value)
    .toLowerCase()
    .replace(/i/g, 'i')
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'i')
    .replace(/I/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const hasAny = (text: string, keywords: readonly string[]): boolean =>
  keywords.some((keyword) => text.includes(keyword));

const scopeLabel = (scope: string): string => {
  if (scope.startsWith('agriculture_hayvancilik')) return 'hayvancilik';
  if (scope.startsWith('agriculture_islenmis')) return 'islenmis urunler';
  if (scope.startsWith('agriculture_nakliye')) return 'nakliye ve lojistik';
  if (scope.startsWith('agriculture_alet')) return 'tarimsal aletler';
  if (scope.startsWith('agriculture_tarim')) return 'tarim';
  if (scope == 'app') return 'uygulama kullanimi';
  return 'genel tarim';
};

const AGRI_KEYWORDS = {
  tarim: [
    'tarim',
    'bitki',
    'urun',
    'mahsul',
    'ekim',
    'hasat',
    'sera',
    'tarla',
    'parsel',
    'toprak',
    'sulama',
    'gubre',
    'tohum',
    'fid',
    'fide',
    'yaprak',
    'kok',
    'zararli',
    'hastalik',
    'bugday',
    'arpa',
    'misir',
    'domates',
    'biber',
    'patates',
    'meyve',
    'sebze',
  ],
  hayvancilik: [
    'hayvan',
    'hayvancilik',
    'inek',
    'sigir',
    'dana',
    'buza',
    'buzagi',
    'koyun',
    'keci',
    'tavuk',
    'sut',
    'yem',
    'rasyon',
    'barinak',
    'ahir',
    'agil',
    'mastitis',
    'solunum',
    'ishal',
    'tirnak',
    'dogum',
    'tohumlama',
  ],
  islenmis: [
    'islenmis',
    'isleme',
    'gida',
    'paket',
    'paketleme',
    'ambalaj',
    'etiket',
    'depolama',
    'raf omru',
    'vakum',
    'sizdirma',
    'kuf',
    'bozulma',
    'uretim hatti',
    'hijyen',
    'fermente',
  ],
  nakliye: [
    'nakliye',
    'lojistik',
    'sevkiyat',
    'tasima',
    'rota',
    'teslim',
    'teslimat',
    'kamyon',
    'tir',
    'dorse',
    'frigo',
    'soguk zincir',
    'istif',
    'palet',
    'yukleme',
    'bosaltma',
    'yakit',
  ],
  alet: [
    'alet',
    'ekipman',
    'makine',
    'traktor',
    'motor',
    'hidrolik',
    'pompa',
    'rulman',
    'pto',
    'kalibrasyon',
    'nozul',
    'mibzer',
    'pulluk',
    'diskaro',
    'ilaclama makinasi',
    'parca',
    'servis',
  ],
} as const;

const ALL_AGRI_KEYWORDS = [
  ...AGRI_KEYWORDS.tarim,
  ...AGRI_KEYWORDS.hayvancilik,
  ...AGRI_KEYWORDS.islenmis,
  ...AGRI_KEYWORDS.nakliye,
  ...AGRI_KEYWORDS.alet,
];

const mimeFromFileName = (fileName: string): string => {
  const lower = asString(fileName).toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
};

const isPromptWithinSupportedScope = (input: AgriAiInput): boolean => {
  const scope = normalizeScope(input.scope);
  if (scope == 'app') return true;
  if (asString(input.imageBase64).length > 0 && !asString(input.rawPrompt || input.prompt)) {
    return true;
  }

  const normalized = normalizeForMatch(input.rawPrompt || input.prompt);
  if (!normalized) return true;

  if (scope.startsWith('agriculture_tarim')) {
    return hasAny(normalized, AGRI_KEYWORDS.tarim);
  }
  if (scope.startsWith('agriculture_hayvancilik')) {
    return hasAny(normalized, AGRI_KEYWORDS.hayvancilik);
  }
  if (scope.startsWith('agriculture_islenmis')) {
    return hasAny(normalized, AGRI_KEYWORDS.islenmis);
  }
  if (scope.startsWith('agriculture_nakliye')) {
    return hasAny(normalized, AGRI_KEYWORDS.nakliye);
  }
  if (scope.startsWith('agriculture_alet')) {
    return hasAny(normalized, AGRI_KEYWORDS.alet);
  }
  return hasAny(normalized, ALL_AGRI_KEYWORDS);
};

const buildOutOfScopeReply = (scope: string): AgriAiResult => ({
  answer:
    'Bu asistan yalnizca tarim, hayvancilik, islenmis urunler, nakliye ve lojistik, tarimsal aletler ve ekipmanlar alaninda calisir. Bu alanin disina cikamiyorum. Sorunu desteklenen bir sektore gore yeniden yazarsan yardimci olabilirim.',
  recommendations: [
    'Tarim icin soru ornegi: Domates yapraginda leke var, ilk neyi kontrol etmeliyim?',
    'Hayvancilik icin soru ornegi: Sut verimi dustu, rasyonda neye bakayim?',
    'Nakliye icin soru ornegi: Sevkiyatta ezilmeyi azaltmak icin nasil istif yapmaliyim?',
    'Uygulama kullanimi soracaksan Uygulama Asistani modunu kullan.',
  ],
  suspectedIssue: 'Desteklenen alan disi soru',
  confidenceLabel: 'Yuksek',
  provider: 'scope_guard',
  scope,
});

const fallbackForApp = (prompt: string): AgriAiResult => {
  const lower = normalizeForMatch(prompt);
  let answer =
    'Tarim360+1 icinde istedigin islemi adim adim yonlendirebilirim. Hangi ekranda takildigini, ne yapmak istedigini ve gordugun uyariyi yazarsan net yol haritasi verebilirim.';
  let recommendations = [
    'Once yapmak istedigin islemi bir cumleyle yaz.',
    'Hata varsa ekrandaki mesaji aynen paylas.',
    'Ilan, teklif, mesaj, destek veya premium gibi hangi bolumde oldugunu belirt.',
  ];

  if (lower.includes('roket') || lower.includes('ilan')) {
    answer =
      'Ilan islemlerinde once ilan detayina gir, ilan sahibi ve premium durumunu kontrol et, sonra ilgili paket veya roket hakki aktif mi bak. Roket istiyorsan aktif premium veya hak tanimi gerekli olabilir.';
    recommendations = [
      'Ilan detay ekranina gir ve durum bilgisini kontrol et.',
      'Hesabim > Abonelikler alanindan premium veya roket haklarini kontrol et.',
      'Yayinlanmama sorunu varsa destek talebi acip ilan numarasini ekle.',
    ];
  } else if (lower.includes('mesaj')) {
    answer =
      'Mesajlar alaninda once ilgili sohbetin acildigini, sonra karsi taraf bilgisinin dogru eslestigini kontrol et. Yeni mesajlar bildirim ve mesaj sekmesinde ayri gorunur.';
    recommendations = [
      'Mesajlar sekmesine gir ve ilgili sohbeti ac.',
      'Bildirim zilinde okunmamis sayisini kontrol et.',
      'Sorun devam ederse karsi taraf e-postasi veya profil id bilgisiyle destek talebi ac.',
    ];
  } else if (lower.includes('premium') || lower.includes('abon')) {
    answer =
      'Premium, satin alma veya promosyon kodu akisinda aktif plan, bitis tarihi ve haklar profil ayarlarinda tutulur. Sorun varsa satin alma kaydi ile profile aktarim arasina bakmak gerekir.';
    recommendations = [
      'Hesabim > Abonelikleri Yonet ekranina gir.',
      'Aktif plan, bitis tarihi ve haklarin gorunup gorunmedigini kontrol et.',
      'Promosyon kodu kullandiysan tekrar kullanimi ve plan eslesmesini kontrol et.',
    ];
  }

  return {
    answer,
    recommendations,
    confidenceLabel: 'Yuksek',
    provider: 'server_rules',
    scope: 'app',
  };
};

const fallbackForAgriculture = (
  prompt: string,
  scope: string,
  hasImage: boolean,
): AgriAiResult => {
  const lower = normalizeForMatch(prompt);
  const normalizedScope = normalizeScope(scope);
  const domain = scopeLabel(scope);
  const isTarim =
    normalizedScope == 'agriculture' ||
    normalizedScope.startsWith('agriculture_tarim');
  const isHayvancilik =
    normalizedScope.startsWith('agriculture_hayvancilik');
  const isIslenmis = normalizedScope.startsWith('agriculture_islenmis');
  const isNakliye = normalizedScope.startsWith('agriculture_nakliye');
  const isAlet = normalizedScope.startsWith('agriculture_alet');
  let suspectedIssue = 'Saha verisi eksikligi nedeniyle genel risk degerlendirmesi';
  let confidenceLabel = hasImage ? 'Orta-Yuksek' : 'Orta';
  let answer =
    `Sorunu ${domain} baglaminda ilk once gozlem, tarihce ve son degisiklikler uzerinden ele almak gerekir. Kesin teshis icin belirtilerin ne zaman basladigi, ne kadar alana yayildigi ve son uygulanan islem ya da yem-sulama degisikligi kritik olur.`;
  let recommendations = [
    'Belirtinin ne zaman basladigini ve ne kadar hizli yayildigini not et.',
    'Son 7-10 gunde yapilan sulama, gubre, ilac, yem veya sevkiyat degisikligini yaz.',
    'Yakin plan ve genel gorunum olacak sekilde ek foto veya detay bilgi ekle.',
    'Once dusuk maliyetli kontrol adimlarini uygula, sonuc degismezse uzman incelemesine gec.',
  ];

  if (
    isTarim &&
    hasAny(lower, [
      'yaprak',
      'leke',
      'sararma',
      'kuruma',
      'mantar',
      'pas hastaligi',
      'mildiyo',
      'yaniklik',
      'kloroz',
      'boz renk',
    ])
  ) {
    suspectedIssue = 'Yaprak hastaligi, mantar baskisi veya besin stresi olabilir';
    confidenceLabel = hasImage ? 'Yuksek' : 'Orta-Yuksek';
    answer =
      'Yaprakta leke, sararma veya kuruma varsa tek bir nedene atlamak dogru olmaz. Once sulama duzeni, yaprak alti zararlilari, son ilaclama ve mikro besin dengesini ayni tabloda kontrol etmek gerekir. Nem yuksekse mantar baskisi, duzensiz sulama varsa stres kaynagi one cikabilir.';
    recommendations = [
      'Ayni parselde saglam ve sorunlu bitkileri karsilastir.',
      'Yaprak alti zararlilari, mantar izi ve damla sulama duzenini kontrol et.',
      'Son gubre ve ilac uygulamasinin tarihini kaydet.',
      'Yayilim hizliysa ziraat muhendisi ile teshisi kesinlestir.',
    ];
  } else if (
    isTarim &&
    hasAny(lower, [
      'sulama',
      'su az',
      'susuz',
      'damla',
      'su birik',
      'drenaj',
      'solma',
      'kok bogul',
      'taban suyu',
    ])
  ) {
    suspectedIssue = 'Sulama programi veya drenaj dengesizligi olabilir';
    confidenceLabel = 'Orta-Yuksek';
    answer =
      'Bitkide solma veya gelisim geriligi varsa sadece su miktarina degil, sulama zamani ve drenaj durumuna da bakmak gerekir. Az sulama kadar kok bogulmasi yapan fazla su da benzer belirti verebilir.';
    recommendations = [
      'Topragi 15-20 cm derinlikte kontrol ederek nem profilini karsilastir.',
      'Damla hatti, filtre ve nozul tikanikligini kontrol et.',
      'Su birikimi varsa tahliye ve drenaj kanallarini ac.',
      'Ayni parsele toplu su vermek yerine kademeli duzeltme yap.',
    ];
  } else if (
    isTarim &&
    hasAny(lower, [
      'gubre',
      'ph',
      'ec',
      'besin',
      'azot',
      'fosfor',
      'potasyum',
      'mikro element',
      'kalsiyum',
      'magnezyum',
      'cinko',
      'demir',
    ])
  ) {
    suspectedIssue = 'Besin dengesi veya pH kaynakli alim sorunu olabilir';
    confidenceLabel = 'Orta-Yuksek';
    answer =
      'Gubreye ragmen bitki zayif gidiyorsa sorun sadece doz olmayabilir; pH, EC, sulama suyu kalitesi ve kok bolgesindeki tuzluluk alimi bozabilir. Analiz yoksa once belirti-harita eslestirmesi yapmak gerekir.';
    recommendations = [
      'Mumkunse toprak ve sulama suyu pH-EC olcumunu yap.',
      'Belirti alanlari ile saglam alanlari ayri not et.',
      'Tek seferde yuksek doz yerine parcali ve dengeli uygulama dusun.',
      'Mikro element eksikligi supheliyse yaprak analizi ile teyit et.',
    ];
  } else if (
    isTarim &&
    hasAny(lower, [
      'bocek',
      'zararli',
      'bit',
      'thrips',
      'trips',
      'beyaz sinek',
      'kirli yesil',
      'kemirme',
      'delik',
      'kurt',
    ])
  ) {
    suspectedIssue = 'Zararli baskisi veya ikincil hastalik riski olabilir';
    confidenceLabel = hasImage ? 'Orta-Yuksek' : 'Orta';
    answer =
      'Zararli baskisinda dogru mudahale icin once zararlinin tipi, yogunlugu ve yayilim alani gorulmelidir. Erken donemde mekanik kontrol ve hedefli uygulama, gec kalmis genis alan ilaclamadan daha verimli olabilir.';
    recommendations = [
      'Yaprak alti ve taze surgunleri yakin incele.',
      'Sari veya mavi tuzak varsa yogunluk trendini kontrol et.',
      'Lokal alanlarda once hedefli mudahale dusun.',
      'Yayilim hizliysa uzmanla etken madde rotasyonu planla.',
    ];
  } else if (
    isHayvancilik &&
    hasAny(lower, [
      'sut',
      'yem',
      'istah',
      'barinak',
      'hayvan',
      'verim dususu',
      'rasyon',
      'gevis',
      'su tuketimi',
    ])
  ) {
    suspectedIssue = 'Rasyon, su tuketimi veya barinak stresi kaynakli performans kaybi olabilir';
    answer =
      'Hayvancilikta verim dususu genelde tek baslikli olmaz; yem degisimi, su tuketimi, barinak sicakligi, altlik ve hastalik baskisi birlikte kontrol edilmelidir. Ani dusus varsa once yem-sulama kaydini ve hayvan davranisindaki degisimi karsilastirmak gerekir.';
    recommendations = [
      'Son yem degisikligini ve gunluk tuketimi kontrol et.',
      'Su erisimi, sicaklik ve havalandirmayi olc.',
      'Istahsizlik, topallik veya ates gibi ek bulgu var mi bak.',
      'Ani kayipta veteriner destegiyle kayitli inceleme yap.',
    ];
  } else if (
    isHayvancilik &&
    hasAny(lower, [
      'mastitis',
      'meme',
      'somatik',
      'sut phtisi',
      'sutte kan',
      'memede sicaklik',
    ])
  ) {
    suspectedIssue = 'Mastitis veya sagim hijyeni kaynakli meme problemi olabilir';
    confidenceLabel = 'Yuksek';
    answer =
      'Meme sertligi, sutta phtilaşma veya ani sut dususu varsa mastitis riski yuksektir. Bu durumda hijyen zinciri, sagim ekipmani ve etkilenen hayvanin ayrimi birlikte ele alinmalidir.';
    recommendations = [
      'Etkilenen hayvani kayda alip sutunu ayir.',
      'Sagim oncesi-sonrasi hijyen ve daldirma prosedurunu kontrol et.',
      'Sagim makinasi vakum ve lastik durumunu incele.',
      'Veteriner destegiyle uygun test ve tedavi planini kur.',
    ];
  } else if (
    isHayvancilik &&
    hasAny(lower, [
      'ishal',
      'diski',
      'sulu',
      'buza',
      'buzagi',
      'dehidrasyon',
      'karin cekme',
    ])
  ) {
    suspectedIssue = 'Ishal, hijyen sorunu veya enfeksiyon riski olabilir';
    answer =
      'Ozellikle buzagi ve genc hayvanda ishal hizla su kaybi ve performans dususu yaratir. Once su-elektrolit dengesi, barinak hijyeni ve yem gecisi hatasi degerlendirilmelidir.';
    recommendations = [
      'Susuzluk bulgularini ve vucut isi durumunu kontrol et.',
      'Kirli altligi ve ortak suluklari hizla temizle.',
      'Yem veya sut ikame degisikligi varsa son tarihi not et.',
      'Kanli ishal, cokme veya ates varsa acil veteriner destegi al.',
    ];
  } else if (
    isHayvancilik &&
    hasAny(lower, [
      'oksuruk',
      'nefes',
      'solunum',
      'burun akintisi',
      'hirilti',
      'akciger',
    ])
  ) {
    suspectedIssue = 'Solunum yolu stresi veya enfeksiyon olabilir';
    answer =
      'Solunum bulgularinda havalandirma, amonyak birikimi, sicaklik farki ve hayvan yogunlugu ilk bakilacak alanlardir. Enfeksiyon suphelerinde zaman kaybetmeden grup bazli yayilim riski degerlendirilmelidir.';
    recommendations = [
      'Barinak havalandirmasi ve nemi kontrol et.',
      'Burun akintisi, ates ve yem kesme durumunu ayri not et.',
      'Hasta grubu mumkunse izole et.',
      'Hirilti veya hizli yayilim varsa veteriner muayenesine gec.',
    ];
  } else if (
    isIslenmis &&
    hasAny(lower, [
      'paket sisme',
      'sisme',
      'vakum',
      'sizdirma',
      'ambalaj',
      'kapak',
      'etiket',
      'raf omru',
    ])
  ) {
    suspectedIssue = 'Ambalaj butunlugu veya vakum prosesinde sorun olabilir';
    confidenceLabel = 'Orta-Yuksek';
    answer =
      'Islenmis urunde paket sisme, sizdirma veya kisa raf omru varsa once proses sicakligi, kapama kalitesi ve ambalaj butunlugu birlikte incelenmelidir. Tek basina etiket tarihi degil, lot bazli proses farki onemlidir.';
    recommendations = [
      'Sorunlu lotlari saglam lotlardan ayir ve lot numarasini sabitle.',
      'Kapama/cene ayari ile ambalaj kalinligini tekrar kontrol et.',
      'Saklama sicakligi ve sevkiyat zincirini kayda al.',
      'Mikrobiyolojik risk supheliyse piyasaya cikisi gecici durdur.',
    ];
  } else if (
    isIslenmis &&
    hasAny(lower, [
      'kuf',
      'koku',
      'renk degisimi',
      'kararma',
      'bozulma',
      'eksi',
      'fermente',
    ])
  ) {
    suspectedIssue = 'Mikrobiyal bozulma veya depolama kosulu kaynakli kalite kaybi olabilir';
    answer =
      'Koku, renk ve doku bozulmasi goruluyorsa sadece urune degil depolama, nem, temas yuzeyleri ve CIP hijyenine birlikte bakmak gerekir. Tekrarlayan bozulma genelde proseste standardizasyon eksigine isaret eder.';
    recommendations = [
      'Lot bazli depolama sicakligi ve bekleme suresini incele.',
      'Uretim hatti temizlik kayitlarini gozden gecir.',
      'Temas eden yuzeylerde tekrar kontaminasyon ihtimalini kontrol et.',
      'Gida guvenligi riski varsa numune alarak analize gonder.',
    ];
  } else if (
    isNakliye &&
    hasAny(lower, [
      'nakliye',
      'sevkiyat',
      'lojistik',
      'ezil',
      'hasar',
      'gecikme',
      'rota',
      'teslim',
      'yakit',
    ])
  ) {
    suspectedIssue = 'Yukleme plani, ambalaj veya rota kaynakli lojistik kayip olabilir';
    answer =
      'Nakliye kaynakli kalite kaybinda yukleme sirasi, ambalaj sertligi, istif yuksekligi ve teslim suresi birlikte degerlendirilmelidir. Urun ezilmesi veya isinma varsa rota planindan once ambalaj ve havalandirma duzenini kontrol etmek gerekir.';
    recommendations = [
      'Istif yuksekligi ve ambalaj dayanimini kontrol et.',
      'Yukleme bosluklarini sabitleme ekipmani ile azalt.',
      'Teslim suresi ve arac ici sicakligi kayda al.',
      'Hasarli lotlari ayirip tekrar paketleme ihtiyacini degerlendir.',
    ];
  } else if (
    isNakliye &&
    hasAny(lower, [
      'soguk zincir',
      'frigo',
      'sicaklik',
      'isi kaybi',
      'derece',
      'sofralik',
      'donuk',
    ])
  ) {
    suspectedIssue = 'Soguk zincir kirilmasi veya arac ekipmani sorunu olabilir';
    confidenceLabel = 'Yuksek';
    answer =
      'Soguk zincirde kisa sureli derece sapmasi bile kaliteyi hizla dusurebilir. Bu durumda aracin ayar kaydi, kapak acilma sikligi ve yukun hava dolasimina izin verip vermedigi birlikte kontrol edilmelidir.';
    recommendations = [
      'Sevkiyat oncesi ve teslim anindaki derece kaydini karsilastir.',
      'Kapak acilma sayisi ve bekleme surelerini not et.',
      'Palet yerlesiminin hava sirkulasyonunu kesip kesmedigini kontrol et.',
      'Tekrarlayan sapmada sogutucu ekipman bakimini planla.',
    ];
  } else if (
    isNakliye &&
    hasAny(lower, [
      'maliyet',
      'fiyat',
      'yakit',
      'bos donus',
      'doluluk',
      'rota optimizasyon',
    ])
  ) {
    suspectedIssue = 'Rota ve doluluk verimsizligi maliyet baskisi yaratiyor olabilir';
    answer =
      'Nakliye maliyeti yukseliyorsa sadece yakita bakmak yeterli degildir; bos donus, eksik doluluk, bekleme suresi ve daginik teslim noktasi ana kayip kalemleridir. Once rota yogunlugu ile arac kapasite kullanimini birlestirmek gerekir.';
    recommendations = [
      'Bos donus oranini ve arac doluluk oranini cikart.',
      'Ayni bolgedeki teslimleri gruplayip rota tekrari azalt.',
      'Yakit tuketimindeki ani artis ile surucu/rota kaydini eslestir.',
      'Bekleme kaynakli maliyetler icin yukleme planini yeniden duzenle.',
    ];
  } else if (
    isAlet &&
    hasAny(lower, [
      'traktor',
      'ekipman',
      'hidrolik',
      'alet',
      'traktör',
      'makine',
      'pto',
      'rulman',
      'kalibrasyon',
    ])
  ) {
    suspectedIssue = 'Tarimsal ekipman ayari, asinma veya hidrolik basinc sorunu olabilir';
    answer =
      'Tarimsal alet veya ekipman sorunu varsa once emniyetli sekilde gorsel kontrol, sonra baglanti noktasi ve yag-basinci degerleri kontrol edilmelidir. Parca degisimi yapmadan once gevseklik, asinma ve yanlis ayar ihtimali dislanmalidir.';
    recommendations = [
      'Civata, baglanti ve ayar noktalari bosluk acisindan kontrol et.',
      'Yag seviyesi, basinc ve filtre durumunu incele.',
      'Asinan parcayi olcmeden degisim karari verme.',
      'Kullanim kilavuzundaki servis araligini karsilastir.',
    ];
  } else if (
    isAlet &&
    hasAny(lower, [
      'hidrolik kaldirmiyor',
      'hidrolik',
      'pompa',
      'yavas kalkiyor',
      'basinc dusuk',
      'kol inmiyor',
    ])
  ) {
    suspectedIssue = 'Hidrolik basinc kaybi, kaçak veya filtre tikali olabilir';
    confidenceLabel = 'Orta-Yuksek';
    answer =
      'Hidrolik sistemde yavaslama veya kaldirmama varsa once yag seviyesi, filtre, hortum kacagi ve pompa sesi kontrol edilmelidir. Dogrudan pompa degisimi yerine basinc kaybini noktasal bulmak daha dogrudur.';
    recommendations = [
      'Yag seviyesi ve yag rengine bak.',
      'Hortum, rekor ve silindir cevresinde kacak izi ara.',
      'Filtre ve emis hatti tikanikligini kontrol et.',
      'Basinc olcme imkani varsa servis degerleriyle karsilastir.',
    ];
  } else if (
    isAlet &&
    hasAny(lower, [
      'calismiyor',
      'mars',
      'marş',
      'akü',
      'aku',
      'stop ediyor',
      'yakit gelmiyor',
      'motor ses',
    ])
  ) {
    suspectedIssue = 'Elektrik, aku veya yakit besleme sorunu olabilir';
    answer =
      'Makine calismiyor veya stop ediyorsa akuden yakit hattina kadar temel zinciri sirasiyla kontrol etmek gerekir. Birden fazla ariza belirtisi benzer gorunse de once kolay ve dusuk maliyetli kontroller yapilmalidir.';
    recommendations = [
      'Aku kutup basi, sarj durumu ve sase baglantisini kontrol et.',
      'Yakit filtresi ve hava alma ihtimalini incele.',
      'Mars basarken ses degisimi olup olmadigini not et.',
      'Uzun zorlamadan kacip temel elektrigi olcerek ilerle.',
    ];
  } else if (
    isAlet &&
    hasAny(lower, [
      'ilaclama',
      'nozul',
      'puskurtme',
      'kalibrasyon',
      'esit dagilmiyor',
      'memeler',
    ])
  ) {
    suspectedIssue = 'Kalibrasyon veya meme/nozul asimasi olabilir';
    answer =
      'Ilaclama veya gubreleme ekipmaninda dengesiz dagilim varsa ilk bakilacak yer kalibrasyon, meme asinmasi ve basinc stabilitesidir. Ekipman duzgun gorunse bile uygulama miktari ciddi sapabilir.';
    recommendations = [
      'Tum memelerin debisini ve puskurtme desenini karsilastir.',
      'Calisma basincini sabit tutup tekrar olcum yap.',
      'Asinmis veya tikali memeleri ayir.',
      'Dekara dusen miktari saha denemesiyle yeniden kalibre et.',
    ];
  } else if (hasImage && !asString(prompt)) {
    suspectedIssue = 'Yalniz foto ile ilk tarama yapildi, ek metin gerekli';
    answer =
      'Fotograf ilk tarama icin yararlidir ancak kesin yonlendirme icin urunun turu, belirti suresi ve son uygulamalar gerekir. Gorselde riskli gorunen noktayi tarif eden kisa bir metin eklersen daha net yonlendirme verilebilir.';
    recommendations = [
      'Yakindan ve genel gorunum olacak iki farkli foto ekle.',
      'Belirtinin suresini ve yayilim hizini yaz.',
      'Son sulama, ilac, gubre veya yem degisikligini ekle.',
    ];
  }

  return {
    answer,
    recommendations,
    suspectedIssue,
    confidenceLabel,
    provider: 'server_rules',
    scope,
  };
};

const buildRulesFallback = (input: AgriAiInput): AgriAiResult => {
  const prompt = asString(input.rawPrompt || input.prompt);
  const scope = normalizeScope(input.scope);
  if (scope == 'app') {
    return fallbackForApp(prompt);
  }
  return fallbackForAgriculture(prompt, scope, asString(input.imageBase64).length > 0);
};

const buildSystemPrompt = (input: AgriAiInput): string => {
  const scope = normalizeScope(input.scope);
  const domain = scopeLabel(scope);
  const hasImage = asString(input.imageBase64).length > 0;
  return [
    'Sen Tarim360+1 icin calisan uzman bir tarim yapay zeka asistansin.',
    `Odak alanin: ${domain}.`,
    'Cevabi her zaman Turkce ver.',
    'Kisa ama uygulanabilir, teknik ve sahada ise yarar sekilde cevap ver.',
    'Her cevapta somut adim, risk ve oncelik sirasi ver.',
    'Kesin tani koyma; gerekli yerde sahada uzman incelemesi veya veteriner/zirai danisman kontrolu oner.',
    'Eger soru tarim, hayvancilik, islenmis urunler, nakliye ve lojistik, tarimsal aletler ve ekipmanlar alani disindaysa yalnizca bu anlama gelen kisa bir yonlendirme don: Bu asistan desteklenen sektorler disina cikamaz; kullaniciya Tarim, Hayvancilik, Islenmis Urunler, Nakliye-Lojistik veya Tarimsal Aletler alaninda yeniden sormasini soyle.',
    hasImage
      ? 'Fotograf verisi varsa gorsele bakarak olasi riskleri yorumla ama kesin tani gibi yazma.'
      : 'Yalniz metinden cikarim yaptiginda kesin tani vermeden risk ve kontrol adimlari oner.',
    'Yanit yalniz JSON olsun.',
    'answer alani 2-4 cumle olsun ve sirayla durum, neden, ilk aksiyon mantigi icersin.',
    'recommendations alaninda ilk 24 saatte yapilacak somut maddeler olsun.',
    'JSON seklinde don: {"answer":"...","suspectedIssue":"...","confidenceLabel":"...","recommendations":["...","..."]}',
    'recommendations 3 ila 6 madde olsun.',
    'confidenceLabel olarak Yuksek, Orta-Yuksek, Orta veya Dusuk-Orta kullan.',
  ].join(' ');
};

const callOpenAi = async (input: AgriAiInput): Promise<AgriAiResult> => {
  const prompt = asString(input.prompt);
  const hasImage = asString(input.imageBase64).length > 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const userContent = hasImage
      ? [
          { type: 'text', text: prompt || 'Fotografi analiz et ve saha icin uygulanabilir yonlendirme ver.' },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeFromFileName(asString(input.fileName))};base64,${asString(input.imageBase64)}`,
            },
          },
        ]
      : prompt || 'Lutfen kullanicinin tarimsal sorununu analiz et.';

    const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: hasImage ? OPENAI_VISION_MODEL : OPENAI_MODEL,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: buildSystemPrompt(input),
          },
          {
            role: 'user',
            content: userContent,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`AI provider failed (${res.status}): ${text}`);
    }

    const body = (await res.json()) as Record<string, any>;
    const rawContent =
      body?.choices?.[0]?.message?.content ??
      body?.output_text ??
      '';
    const contentText =
      typeof rawContent === 'string'
        ? rawContent
        : Array.isArray(rawContent)
          ? rawContent
              .map((row) => asString((row as Record<string, unknown>)?.text))
              .filter((row) => row.length > 0)
              .join('\n')
          : '';
    const data = parseJsonObject(contentText);
    if (!data) {
      throw new Error('AI provider response is not valid JSON.');
    }

    const fallback = buildRulesFallback(input);
    const answer = asString(data.answer || data.message || data.text);
    if (!answer) {
      throw new Error('AI provider returned empty answer.');
    }

    const remoteTips = asStringList(
      data.recommendations || data.actions || data.suggestions,
    );
    return {
      answer,
      recommendations:
        remoteTips.length > 0 ? remoteTips : fallback.recommendations,
      suspectedIssue:
        asString(data.suspectedIssue || data.diagnosis || data.disease) ||
        fallback.suspectedIssue,
      confidenceLabel:
        asString(data.confidenceLabel || data.confidence || data.risk) ||
        fallback.confidenceLabel,
      provider: 'openai',
      scope: normalizeScope(input.scope),
    };
  } finally {
    clearTimeout(timer);
  }
};

export const generateAgriAiReply = async (
  input: AgriAiInput,
): Promise<AgriAiResult> => {
  const scope = normalizeScope(input.scope);
  if (!isPromptWithinSupportedScope(input)) {
    return buildOutOfScopeReply(scope);
  }
  if (input.forceRulesOnly) {
    return buildRulesFallback(input);
  }
  if (OPENAI_API_KEY) {
    try {
      return await callOpenAi(input);
    } catch (_) {
      return buildRulesFallback(input);
    }
  }
  return buildRulesFallback(input);
};
