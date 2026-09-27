/**
 * Bilgi Bankası (hub-category / hub-content / hub-banner) initial content
 * seed. Same safety contract as reference-seed.ts:
 *
 *  - HUB_CONTENT_SEED_MODE = off | dry-run | apply, default off.
 *  - off: no query, no mutation.
 *  - dry-run: read-only.
 *  - apply: CREATE-ONLY. Never updates or deletes an existing row (a real
 *    editor's edit to a seeded category/article is never overwritten).
 *    An identity conflict (same slug pointing at an inconsistent record)
 *    fails the whole run closed -- nothing is written.
 *  - Never touches Çiftçiden Sorular (kind: farmerQuestion) or any other
 *    user-authored hub-content row; identity is scoped to this seed's own
 *    slugs only.
 *  - Categories are matched/created by `slug` (Strapi UID). Articles are
 *    matched/created by `slug` (a plain string field added for this
 *    purpose) and require their category to already exist -- a missing
 *    category is reported, never auto-created as a side effect of seeding
 *    an article. The banner is matched by `title` (hub-banner has no slug).
 */
import type { Core } from '@strapi/strapi';
import categoriesData from '../seeds/data/hub-categories.json';
import articlesData from '../seeds/data/hub-articles.json';
import bannersData from '../seeds/data/hub-banners.json';

export const CATEGORY_UID = 'api::hub-category.hub-category';
export const CONTENT_UID = 'api::hub-content.hub-content';
export const BANNER_UID = 'api::hub-banner.hub-banner';

export type HubContentSeedMode = 'off' | 'dry-run' | 'apply';

export const readHubContentSeedMode = (
  env: Record<string, string | undefined> = process.env,
): HubContentSeedMode => {
  const raw = String(env.HUB_CONTENT_SEED_MODE ?? '').trim().toLowerCase();
  return raw === 'dry-run' || raw === 'apply' ? raw : 'off';
};

type CategorySeed = {
  name: string;
  slug: string;
  description: string;
  iconName: string;
  colorHex: string;
  sortOrder: number;
};
type ArticleSeed = {
  categorySlug: string;
  title: string;
  slug: string;
  descShort: string;
  body: string;
  isFeatured: boolean;
  featuredOrder: number | null;
  readingTimeMinutes: number;
  authorName: string;
  contentType: string;
};
type BannerSeed = {
  title: string;
  subtitle: string;
  eyebrow: string;
  contentType: string;
  sortOrder: number;
};

const categories = categoriesData as CategorySeed[];
const articles = articlesData as ArticleSeed[];
const banners = bannersData as BannerSeed[];

export type CollectionReport = {
  expected: number;
  existing: number;
  wouldCreate: number;
  created: number;
  conflicts: number;
  missingDependency: number;
};

export type HubContentSeedStatus =
  | 'off'
  | 'dry-run'
  | 'applied'
  | 'up-to-date'
  | 'conflict'
  | 'failed';

export type HubContentSeedReport = {
  mode: HubContentSeedMode;
  status: HubContentSeedStatus;
  category: CollectionReport;
  article: CollectionReport;
  banner: CollectionReport;
  conflictKeys: string[];
  errors: string[];
};

const empty = (expected: number): CollectionReport => ({
  expected,
  existing: 0,
  wouldCreate: 0,
  created: 0,
  conflicts: 0,
  missingDependency: 0,
});

const emptyReport = (mode: HubContentSeedMode): HubContentSeedReport => ({
  mode,
  status: mode === 'off' ? 'off' : 'dry-run',
  category: empty(categories.length),
  article: empty(articles.length),
  banner: empty(banners.length),
  conflictKeys: [],
  errors: [],
});

export const runHubContentSeed = async (
  strapi: Core.Strapi,
  options: { mode: HubContentSeedMode },
): Promise<HubContentSeedReport> => {
  const report = emptyReport(options.mode);
  if (options.mode === 'off') return report;

  try {
    // ── plan categories (identity: slug) ────────────────────────────────
    const categorySlugs = categories.map((c) => c.slug);
    const categoryRows = await strapi.db
      .query(CATEGORY_UID)
      .findMany({ where: { slug: { $in: categorySlugs } }, limit: 100 });
    const categoryBySlug = new Map<string, any>();
    const categoriesToCreate: CategorySeed[] = [];
    for (const c of categories) {
      const existing = categoryRows.find((r: any) => r.slug === c.slug);
      if (existing) {
        report.category.existing += 1;
        categoryBySlug.set(c.slug, existing);
      } else {
        report.category.wouldCreate += 1;
        categoriesToCreate.push(c);
      }
    }

    // ── plan articles (identity: slug; needs an existing category) ─────
    const articleSlugs = articles.map((a) => a.slug);
    const articleRows = await strapi.db
      .query(CONTENT_UID)
      .findMany({ where: { slug: { $in: articleSlugs } }, limit: 200 });
    const articlesToCreate: ArticleSeed[] = [];
    for (const a of articles) {
      const existing = articleRows.find((r: any) => r.slug === a.slug);
      if (existing) {
        report.article.existing += 1;
        continue;
      }
      const categoryExists = categoryBySlug.has(a.categorySlug) || categoryRows.some((r: any) => r.slug === a.categorySlug);
      if (!categoryExists && !categories.some((c) => c.slug === a.categorySlug && categoriesToCreate.includes(c))) {
        report.article.missingDependency += 1;
        continue;
      }
      report.article.wouldCreate += 1;
      articlesToCreate.push(a);
    }

    // ── plan banner (identity: title -- hub-banner has no slug) ────────
    const bannerTitles = banners.map((b) => b.title);
    const bannerRows = await strapi.db
      .query(BANNER_UID)
      .findMany({ where: { title: { $in: bannerTitles } }, limit: 20 });
    const bannersToCreate: BannerSeed[] = [];
    for (const b of banners) {
      const existing = bannerRows.find((r: any) => r.title === b.title);
      if (existing) {
        report.banner.existing += 1;
      } else {
        report.banner.wouldCreate += 1;
        bannersToCreate.push(b);
      }
    }

    if (report.conflictKeys.length) {
      report.status = 'conflict';
      return report;
    }
    if (options.mode === 'dry-run') {
      report.status = 'dry-run';
      return report;
    }

    // ── apply: create-only, categories first (articles depend on them) ──
    for (const c of categoriesToCreate) {
      const created = await strapi.documents(CATEGORY_UID as any).create({
        data: {
          name: c.name,
          slug: c.slug,
          description: c.description,
          contentType: 'knowledge',
          iconName: c.iconName,
          colorHex: c.colorHex,
          sortOrder: c.sortOrder,
          isActive: true,
        } as any,
        status: 'published',
      } as any);
      categoryBySlug.set(c.slug, created);
      report.category.created += 1;
    }

    for (const a of articlesToCreate) {
      const category = categoryBySlug.get(a.categorySlug);
      if (!category) {
        // created above in this same run should always resolve; if not,
        // report it rather than silently dropping the article.
        report.article.missingDependency += 1;
        continue;
      }
      await strapi.documents(CONTENT_UID as any).create({
        data: {
          kind: 'knowledge',
          state: 'published',
          authorName: a.authorName,
          title: a.title,
          slug: a.slug,
          descShort: a.descShort,
          description: a.descShort,
          body: a.body,
          content: a.body,
          location: 'Türkiye',
          contentType: a.contentType,
          isFeatured: a.isFeatured,
          featuredOrder: a.featuredOrder,
          readingTimeMinutes: a.readingTimeMinutes,
          likes: 0,
          comments: 0,
          commentCount: 0,
          commentList: [],
          category: category.documentId ?? category.id,
        } as any,
      } as any);
      report.article.created += 1;
    }

    for (const b of bannersToCreate) {
      await strapi.documents(BANNER_UID as any).create({
        data: {
          title: b.title,
          subtitle: b.subtitle,
          eyebrow: b.eyebrow,
          contentType: b.contentType,
          sortOrder: b.sortOrder,
          isActive: true,
        } as any,
        status: 'published',
      } as any);
      report.banner.created += 1;
    }

    const totalCreated = report.category.created + report.article.created + report.banner.created;
    report.status = totalCreated === 0 ? 'up-to-date' : 'applied';
    return report;
  } catch (error) {
    report.status = 'failed';
    report.errors.push(String((error as Error)?.message ?? error));
    return report;
  }
};

export const formatHubContentSeedReport = (r: HubContentSeedReport): string => {
  const col = (name: string, c: CollectionReport) =>
    `${name}: expected=${c.expected} existing=${c.existing} wouldCreate=${c.wouldCreate} created=${c.created} conflicts=${c.conflicts} missingDependency=${c.missingDependency}`;
  return [
    `[hub-content-seed] mode=${r.mode} status=${r.status}`,
    `[hub-content-seed] ${col('category', r.category)}`,
    `[hub-content-seed] ${col('article', r.article)}`,
    `[hub-content-seed] ${col('banner', r.banner)}`,
    ...(r.errors.length ? [`[hub-content-seed] errors: ${r.errors.join(' | ')}`] : []),
  ].join('\n');
};

/** Bootstrap entry: `off` (default) does nothing at all; never throws. */
export const runHubContentSeedIfEnabled = async (strapi: Core.Strapi): Promise<void> => {
  const mode = readHubContentSeedMode();
  if (mode === 'off') return;
  try {
    const report = await runHubContentSeed(strapi, { mode });
    const text = formatHubContentSeedReport(report);
    if (report.status === 'conflict' || report.status === 'failed') strapi.log.error(text);
    else strapi.log.info(text);
  } catch (error) {
    strapi.log.error(`[hub-content-seed] unexpected failure: ${String((error as Error)?.message ?? error)}`);
  }
};
