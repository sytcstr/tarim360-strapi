export type AgriCurrency = 'TRY' | 'USD' | 'EUR';

export type AgriPriceRecord = {
  productName: string;
  provinceName: string;
  minPrice: number;
  maxPrice: number;
  averagePrice: number;
  currency: AgriCurrency;
  unit: string;
  observedAt: string;
  sourceName: string;
  sourceUrl: string;
  confidence: number;
};

export type PersistableAgriPriceRecord = AgriPriceRecord & {
  dedupeKey: string;
};

export type AgriAdapterContext = {
  now: Date;
};

export interface AgriDataSourceAdapter {
  readonly id: string;
  fetch(context: AgriAdapterContext): Promise<AgriPriceRecord[]>;
}

export type AgriPersistResult = 'created' | 'duplicate';

export type AgriPricePersister = (
  record: PersistableAgriPriceRecord,
) => Promise<AgriPersistResult>;

export type AgriIngestionSummary = {
  adapter: string;
  received: number;
  created: number;
  duplicates: number;
  invalid: number;
  startedAt: string;
  finishedAt: string;
};
