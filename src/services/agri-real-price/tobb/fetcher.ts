/**
 * Polite, bounded HTTP access to borsa.tobb.org.tr.
 *  - honest User-Agent, sequential requests with a pause between them
 *  - timeout, bounded retry with backoff (network / 5xx / 429 only; other 4xx never retried)
 *  - response size cap
 * The transport is injectable so tests never touch the network.
 */
import https from 'node:https';
import tls from 'node:tls';
import { SECTIGO_DV_R36_INTERMEDIATE_PEM } from './tls';

export const TOBB_BASE_URL = 'https://borsa.tobb.org.tr';
export const TOBB_USER_AGENT = 'Tarim360 agricultural data service';

export type RawResponse = { status: number; contentType: string; body: string };
export type HttpGet = (url: string, opts: { timeoutMs: number; userAgent: string; maxBytes: number }) => Promise<RawResponse>;

let cachedCa: string[] | null = null;
const trustList = (): string[] => {
  if (!cachedCa) cachedCa = [...tls.rootCertificates, SECTIGO_DV_R36_INTERMEDIATE_PEM];
  return cachedCa;
};

/**
 * HTTPS GET with full certificate verification. TOBB omits its intermediate
 * certificate, so the (public) Sectigo intermediate is added to the trust list
 * (see tls.ts); verification is never disabled.
 */
export const defaultHttpGet: HttpGet = (url, { timeoutMs, userAgent, maxBytes }) =>
  new Promise<RawResponse>((resolve, reject) => {
    const req = https.get(
      url,
      { ca: trustList(), headers: { 'user-agent': userAgent, accept: 'text/html' }, timeout: timeoutMs },
      (res) => {
        const declared = Number(res.headers['content-length'] ?? 0);
        if (declared > maxBytes) {
          res.destroy();
          resolve({ status: 413, contentType: '', body: '' });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            resolve({ status: 413, contentType: '', body: '' });
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { name: 'AbortError' })));
    req.on('error', reject);
  });

export type FetchOutcome =
  | { ok: true; body: string }
  | { ok: false; reason: 'timeout' | 'network' | 'http-4xx' | 'http-5xx' | 'not-html' | 'too-large'; status?: number };

export type TobbFetcherOptions = {
  httpGet?: HttpGet;
  sleep?: (ms: number) => Promise<void>;
  /** pause between consecutive requests (politeness) */
  delayMs?: number;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  maxBytes?: number;
};

export const createTobbFetcher = (options: TobbFetcherOptions = {}) => {
  const httpGet = options.httpGet ?? defaultHttpGet;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delayMs = options.delayMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const retries = options.retries ?? 2;
  const backoffMs = options.backoffMs ?? 1500;
  const maxBytes = options.maxBytes ?? 2_000_000;
  let requests = 0;

  const get = async (pathAndQuery: string): Promise<FetchOutcome> => {
    if (requests > 0 && delayMs > 0) await sleep(delayMs);
    requests += 1;
    const url = `${TOBB_BASE_URL}/${pathAndQuery.replace(/^\//, '')}`;
    let last: FetchOutcome = { ok: false, reason: 'network' };
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(backoffMs * attempt);
      try {
        const res = await httpGet(url, { timeoutMs, userAgent: TOBB_USER_AGENT, maxBytes });
        if (res.status === 413) return { ok: false, reason: 'too-large', status: 413 };
        if (res.status >= 500 || res.status === 429) {
          last = { ok: false, reason: 'http-5xx', status: res.status };
          continue;
        }
        if (res.status >= 400) return { ok: false, reason: 'http-4xx', status: res.status };
        if (!/text\/html/i.test(res.contentType)) return { ok: false, reason: 'not-html', status: res.status };
        return { ok: true, body: res.body };
      } catch (error) {
        const aborted = (error as Error)?.name === 'AbortError';
        last = { ok: false, reason: aborted ? 'timeout' : 'network' };
      }
    }
    return last;
  };

  return { get, requestCount: () => requests };
};

export type TobbFetcher = ReturnType<typeof createTobbFetcher>;

export const productPageUrl = (ana: number, alt: number) => `fiyat_urun3.php?ana_kod=${ana}&alt_kod=${alt}`;
