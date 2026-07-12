import products from '../../seeds/data/agri-products.json';
import provinces from '../../seeds/data/turkey-provinces.json';
import type {
  AgriAdapterContext,
  AgriDataSourceAdapter,
  AgriPriceRecord,
} from './types';

type SeedProduct = (typeof products)[number];
type SeedProvince = (typeof provinces)[number];

const categoryBasePrice: Record<string, number> = {
  Hububat: 12,
  Bakliyat: 34,
  'Yağlı Tohumlar': 28,
  Sebze: 18,
  Meyve: 24,
  'Endüstri Bitkileri': 20,
  Kuruyemiş: 135,
  'Yem Bitkileri': 9,
};

const preferredProvinceByCode: Record<string, string> = {
  BUGDAY: 'konya',
  ARPA: 'konya',
  MISIR: 'adana',
  CELTIK: 'samsun',
  NOHUT: 'ankara',
  KIRMIZI_MERCIMEK: 'sanliurfa',
  AYCICEGI: 'tekirdag',
  SOYA_FASULYESI: 'adana',
  YER_FISTIGI: 'osmaniye',
  DOMATES: 'antalya',
  PATATES: 'nigde',
  SOGAN: 'ankara',
  ELMA: 'isparta',
  UZUM: 'manisa',
  PORTAKAL: 'antalya',
  LIMON: 'mersin',
  KIRAZ: 'izmir',
  KAYISI: 'malatya',
  MUZ: 'antalya',
  PAMUK: 'sanliurfa',
  SEKER_PANCARI: 'konya',
  TUTUN: 'manisa',
  CAY: 'rize',
  HASHAS: 'afyonkarahisar',
  FINDIK: 'ordu',
  ANTEP_FISTIGI: 'gaziantep',
  CEVIZ: 'kahramanmaras',
  BADEM: 'mugla',
  KESTANE: 'aydin',
  YONCA: 'konya',
  SILAJLIK_MISIR: 'izmir',
};

const fallbackProvinceSlugs = [
  'konya',
  'ankara',
  'adana',
  'sanliurfa',
  'antalya',
  'manisa',
  'samsun',
  'tekirdag',
  'malatya',
  'ordu',
];

const provinceBySlug = new Map<string, SeedProvince>(
  provinces.map((province) => [province.slug, province]),
);

const roundPrice = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

const mockProvinceFor = (
  product: SeedProduct,
  index: number,
): SeedProvince => {
  const preferredSlug =
    preferredProvinceByCode[product.code] ??
    fallbackProvinceSlugs[index % fallbackProvinceSlugs.length];
  const province = provinceBySlug.get(preferredSlug);
  if (!province) {
    throw new Error(`Mock province not found for ${product.name}: ${preferredSlug}`);
  }
  return province;
};

const mockPriceFor = (
  product: SeedProduct,
  index: number,
  dayNumber: number,
): number => {
  const base = categoryBasePrice[product.category];
  if (!base) throw new Error(`Mock category is not configured: ${product.category}`);
  const productFactor = 1 + (index % 8) * 0.055;
  const dailyFactor = 1 + (((dayNumber + index * 3) % 11) - 5) * 0.004;
  return roundPrice(base * productFactor * dailyFactor);
};

export class MockAgriDataAdapter implements AgriDataSourceAdapter {
  readonly id = 'mock';

  async fetch(context: AgriAdapterContext): Promise<AgriPriceRecord[]> {
    const date = new Date(context.now);
    date.setUTCHours(9, 0, 0, 0);
    const observedAt = date.toISOString();
    const dayNumber = Math.floor(date.getTime() / 86_400_000);
    const sourceName = 'Mock Agricultural Data';
    const sourceUrl = 'https://example.invalid/agri-data/mock';

    return products
      .filter((product) => product.isActive)
      .map((product, index) => {
        const province = mockProvinceFor(product, index);
        const averagePrice = mockPriceFor(product, index, dayNumber);
        return {
          productName: product.name,
          provinceName: province.name,
          minPrice: roundPrice(averagePrice * 0.96),
          maxPrice: roundPrice(averagePrice * 1.04),
          averagePrice,
          currency: 'TRY',
          unit: product.defaultUnit,
          observedAt,
          sourceName,
          sourceUrl,
          confidence: 0.5,
        };
      });
  }
}
