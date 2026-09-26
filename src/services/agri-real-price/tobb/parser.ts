/**
 * TOBB "Ürünlere Göre Günlük Fiyatlar" page parser
 * (https://borsa.tobb.org.tr/fiyat_urun3.php?ana_kod=<n>&alt_kod=<n>).
 *
 * FAIL CLOSED: the table header must match the verified column layout exactly
 * (name, last-trade time, min, max, average, quantity[UNIT], count, amount)
 * and the header unit must equal the unit in the page title. Any deviation
 * returns status "error" and yields NO rows. No number is ever picked by a
 * loose regex from the page.
 */
import { parseTurkishNumber } from './numbers';

export type TobbRawRow = {
  exchangeCode: string;
  exchangeName: string;
  lastTradeText: string;
  min: number | null;
  max: number | null;
  average: number | null;
  quantity: number | null;
  transactionCount: number | null;
  amount: number | null;
};

export type TobbPageResult =
  | { status: 'ok'; group: string; product: string; unit: string; rows: TobbRawRow[]; rowErrors: number }
  | { status: 'no-data'; group: string; product: string; unit: string }
  | { status: 'error'; reason: string };

const stripTags = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const fold = (s: string) =>
  s
    .toLocaleUpperCase('tr-TR')
    .replace(/İ/g, 'I')
    .replace(/Ş/g, 'S')
    .replace(/Ğ/g, 'G')
    .replace(/Ü/g, 'U')
    .replace(/Ö/g, 'O')
    .replace(/Ç/g, 'C')
    .replace(/\s+/g, ' ')
    .trim();

/** Expected column layout after unit/space normalisation. */
const EXPECTED_HEADERS = [
  'BORSA ADI',
  'SON ISLEM TARIHI',
  'EN AZ (TL)',
  'EN COK (TL)',
  'ORTALAMA (TL)',
  'ISLEM MIKTARI (%UNIT%)',
  'ISLEM ADETI',
  'ISLEM TUTARI (TL)',
];

const NO_DATA_TEXT = 'BU URUN ICIN VERI GIRISINDE BULUNULMAMISTIR';

export const parseTobbProductPage = (html: string): TobbPageResult => {
  if (typeof html !== 'string' || html.length < 200) return { status: 'error', reason: 'empty-or-tiny-response' };

  // title: <b><font color='red'>GROUP</font> - <font color='blue'>PRODUCT</font> - <font>UNIT</font></b>
  const title =
    /<b><font[^>]*color='red'[^>]*>([^<]+)<\/font>\s*-\s*<font[^>]*color='blue'[^>]*>([^<]+)<\/font>\s*-\s*<font[^>]*>([^<]+)<\/font><\/b>/i.exec(
      html,
    );
  if (!title) return { status: 'error', reason: 'title-not-found' };
  const group = stripTags(title[1]);
  const product = stripTags(title[2]);
  const unit = stripTags(title[3]).toUpperCase();

  const tableStart = html.search(/<table[^>]*bordercolor/i);
  if (tableStart < 0) {
    if (fold(stripTags(html)).includes(NO_DATA_TEXT)) return { status: 'no-data', group, product, unit };
    return { status: 'error', reason: 'table-not-found' };
  }
  const tableHtml = html.slice(tableStart, html.indexOf('</table>', tableStart) + 8);

  const headers = [...tableHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => fold(stripTags(m[1])));
  const expected = EXPECTED_HEADERS.map((h) => h.replace('%UNIT%', fold(unit)));
  if (headers.length !== expected.length || headers.some((h, i) => h !== expected[i])) {
    return { status: 'error', reason: `header-mismatch: ${headers.join(' | ')}` };
  }

  const body = tableHtml.slice(tableHtml.search(/<tbody/i));
  const rows: TobbRawRow[] = [];
  let rowErrors = 0;
  for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length !== 8) {
      rowErrors += 1;
      continue;
    }
    const link = /borsakod=([^'"&]+)['"]/.exec(cells[0]);
    const text = cells.map(stripTags);
    if (!link || !text[0]) {
      rowErrors += 1;
      continue;
    }
    rows.push({
      exchangeCode: decodeURIComponent(link[1]),
      exchangeName: text[0],
      lastTradeText: text[1],
      min: parseTurkishNumber(text[2]),
      max: parseTurkishNumber(text[3]),
      average: parseTurkishNumber(text[4]),
      quantity: parseTurkishNumber(text[5]),
      transactionCount: parseTurkishNumber(text[6]),
      amount: parseTurkishNumber(text[7]),
    });
  }
  if (rows.length === 0) return { status: 'error', reason: 'table-without-rows' };
  return { status: 'ok', group, product, unit, rows, rowErrors };
};
