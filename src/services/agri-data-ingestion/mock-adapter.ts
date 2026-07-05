import type {
  AgriAdapterContext,
  AgriDataSourceAdapter,
  AgriPriceRecord,
} from './types';

export class MockAgriDataAdapter implements AgriDataSourceAdapter {
  readonly id = 'mock';

  async fetch(context: AgriAdapterContext): Promise<AgriPriceRecord[]> {
    const date = new Date(context.now);
    date.setUTCHours(9, 0, 0, 0);
    const observedAt = date.toISOString();
    const sourceName = 'Mock Agricultural Data';
    const sourceUrl = 'https://example.invalid/agri-data/mock';

    return [
      {
        productName: 'Fındık',
        provinceName: 'Ordu',
        minPrice: 272,
        maxPrice: 288,
        averagePrice: 281,
        currency: 'TRY',
        unit: 'kg',
        observedAt,
        sourceName,
        sourceUrl,
        confidence: 0.5,
      },
      {
        productName: 'Buğday',
        provinceName: 'Konya',
        minPrice: 13.2,
        maxPrice: 14.8,
        averagePrice: 14.1,
        currency: 'TRY',
        unit: 'kg',
        observedAt,
        sourceName,
        sourceUrl,
        confidence: 0.5,
      },
      {
        productName: 'Arpa',
        provinceName: 'Konya',
        minPrice: 10.4,
        maxPrice: 11.8,
        averagePrice: 11.1,
        currency: 'TRY',
        unit: 'kg',
        observedAt,
        sourceName,
        sourceUrl,
        confidence: 0.5,
      },
      {
        productName: 'Mısır',
        provinceName: 'Adana',
        minPrice: 11.4,
        maxPrice: 12.6,
        averagePrice: 12.1,
        currency: 'TRY',
        unit: 'kg',
        observedAt,
        sourceName,
        sourceUrl,
        confidence: 0.5,
      },
    ];
  }
}
