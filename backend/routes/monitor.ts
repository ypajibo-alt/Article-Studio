import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchContentAvailability, extractContentId, getToken } from '../lib/tubi.js';
import { regenerateBlurb } from '../lib/bedrock.js';
import { MS_PER_DAY, CRM_CACHE_TTL_MS } from '../lib/config.js';

const router = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTICLES_DIR = path.resolve(__dirname, '../../the-t-data/data/articles');

// ─── Types ────────────────────────────────────────────────────────────────────

interface TrackableItem {
  position: number;
  title: string;
  description?: string;
  content_title?: string;
  content_type?: string;
  tubi_link: string;
  contentId: string | null;
  availability_starts?: string | null;
  availability_ends?: string | null;
  daysLeft?: number | null;
  status?: string;
}

interface UnifiedArticle {
  id: string;
  slug: string;
  articleType: 'listicle' | 'single' | 'worldcup';
  title: string;
  subtitle?: string;
  items: TrackableItem[];
}

// ─── Load all blog articles ───────────────────────────────────────────────────

export function loadMonitorArticles() {
  return loadAllArticles().map(article => ({
    id: article.id, slug: article.slug, articleType: article.articleType,
    title: article.title, subtitle: article.subtitle,
    itemCount: article.items.length,
    items: article.items,
  }));
}

function loadAllArticles(): UnifiedArticle[] {
  const articles: UnifiedArticle[] = [];

  let files: string[];
  try {
    files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.json'));
  } catch (e) {
    console.error('Cannot read articles dir:', e);
    return articles;
  }

  for (const file of files) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(ARTICLES_DIR, file), 'utf-8'));
    } catch {
      continue;
    }

    const type = String(raw.type ?? '');
    const id = String(raw.id ?? '');
    const slug = String(raw.slug ?? '');
    const title = String(raw.title ?? '');
    const subtitle = String(raw.subtitle ?? '');

    if (type === 'listicle') {
      const rawItems = (raw.items as Record<string, unknown>[]) ?? [];
      const items: TrackableItem[] = rawItems.map((item, idx) => ({
        position: (item.position as number) ?? idx + 1,
        title: String(item.title ?? ''),
        description: String(item.description ?? ''),
        content_title: String(item.contentTitle ?? item.title ?? ''),
        content_type: '',
        tubi_link: String(item.tubiLink ?? ''),
        contentId: String(item.contentId ?? '') || extractContentId(String(item.tubiLink ?? '')),
      }));
      articles.push({ id, slug, articleType: 'listicle', title, subtitle, items });

    } else if (type === 'article') {
      const hero = (raw.hero as Record<string, unknown>) ?? {};
      const contentId = String(hero.contentId ?? '') || null;
      const tubiLink = String(hero.watchLink ?? '') || '';
      const items: TrackableItem[] = contentId ? [{
        position: 1,
        title,
        description: subtitle,
        content_title: title,
        content_type: 'Single Title',
        tubi_link: tubiLink,
        contentId,
      }] : [];
      articles.push({ id, slug, articleType: 'single', title, subtitle, items });
    }
  }

  return articles;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / MS_PER_DAY);
}

function expiryStatus(daysLeft: number | null, foundInApi: boolean, startsIn: number | null): 'expired' | 'critical' | 'warning' | 'ok' | 'stale' | 'unknown' {
  if (!foundInApi) return 'unknown';
  // Title just launched — "coming soon" article angle is now dead
  if (startsIn !== null && startsIn <= 0 && startsIn > -7) return 'stale';
  // Coming soon — flag as warning so editor knows to prep a refresh
  if (startsIn !== null && startsIn > 0 && startsIn <= 30) return 'warning';
  if (startsIn !== null && startsIn > 30) return 'ok';
  // Normal expiry logic
  if (daysLeft === null) return 'ok';
  if (daysLeft < 0) return 'expired';
  if (daysLeft <= 7) return 'critical';
  if (daysLeft <= 30) return 'warning';
  return 'ok';
}

function articleStatus(items: TrackableItem[]): 'critical' | 'warning' | 'stale' | 'ok' | 'unknown' {
  if (!items.length) return 'unknown';
  const critical = items.filter(i => i.status === 'critical' || i.status === 'expired').length;
  const warning = items.filter(i => i.status === 'warning').length;
  const stale = items.filter(i => i.status === 'stale').length;
  const unknown = items.filter(i => i.status === 'unknown').length;
  if (critical > 0) return 'critical';
  if (warning > 0) return 'warning';
  if (stale > 0) return 'stale';
  if (unknown === items.length) return 'unknown';
  return 'ok';
}

// ─── Replacement suggestions ──────────────────────────────────────────────────

type SuggestionResult = {
  contentId: string; title: string; year: number | null; type: string;
  availability_starts: string | null; availability_ends: string | null;
  daysLeft: number | null; startsIn: number | null;
};

let crmCacheIds: string[] = [];
let crmCacheExpiry = 0;
let pendingCrmFetch: Promise<string[]> | null = null;

async function fetchComingSoonCrmIds(): Promise<string[]> {
  if (crmCacheIds.length && Date.now() < crmCacheExpiry) return crmCacheIds;
  if (pendingCrmFetch) return pendingCrmFetch;
  pendingCrmFetch = _fetchComingSoonCrmIds().finally(() => { pendingCrmFetch = null; });
  return pendingCrmFetch;
}

async function _fetchComingSoonCrmIds(): Promise<string[]> {
  try {
    const token = await getToken();
    if (!token) return crmCacheIds;
    const allIds: string[] = [];
    let cursor: string | null = null;
    let page = 0;
    do {
      const url = `https://tensor.production-public.tubi.io/api/v7/containers/coming_soon_crm?expanded=true&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      if (!res.ok) break;
      const d = await res.json() as Record<string, unknown>;
      const container = d.container as Record<string, unknown>;
      const contents = d.contents as Record<string, unknown> ?? {};
      allIds.push(...Object.keys(contents));
      const newCursor = container?.cursor as string | null;
      cursor = (newCursor && newCursor !== cursor) ? newCursor : null;
      page++;
    } while (cursor && page < 20);
    if (allIds.length) {
      crmCacheIds = [...new Set(allIds)];
      crmCacheExpiry = Date.now() + CRM_CACHE_TTL_MS;
    }
    return crmCacheIds;
  } catch { return crmCacheIds; }
}

async function suggestComingSoonReplacements(excludeContentId: string | null): Promise<SuggestionResult[]> {
  const allIds = await fetchComingSoonCrmIds();
  const ids = allIds.filter(id => id !== excludeContentId);
  if (!ids.length) return [];

  const avail = await fetchContentAvailability(ids);
  return avail
    .map(a => {
      const startsIn = daysUntil(a.availability_starts);
      const daysLeft = daysUntil(a.availability_ends);
      return {
        contentId: a.contentId, title: a.title, year: null,
        type: a.type === 's' ? 'Series' : 'Movie',
        availability_starts: a.availability_starts,
        availability_ends: a.availability_ends,
        daysLeft, startsIn,
      };
    })
    .filter(c => c.startsIn !== null && c.startsIn > 0)  // only fully-pipelined upcoming titles
    .sort((a, b) => (b.startsIn ?? 0) - (a.startsIn ?? 0))  // furthest arrival first
    .slice(0, 3);
}

async function searchTubiForSuggestions(
  query: string,
  excludeContentId: string | null,
  isComingSoon = false,
): Promise<SuggestionResult[]> {
  if (isComingSoon) return suggestComingSoonReplacements(excludeContentId);

  const token = await getToken();
  if (!token) return [];

  const url = `https://search.production-public.tubi.io/api/v2/search?search=${encodeURIComponent(query)}&limit=50`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];

  const data = await res.json() as Record<string, unknown>;
  const contents = data.contents as Record<string, Record<string, unknown>> ?? {};

  const candidates = Object.values(contents)
    .filter(item => String(item.id) !== excludeContentId)
    .slice(0, 20)
    .map(item => ({ id: String(item.id), title: String(item.title ?? ''), year: (item.year as number) ?? null, type: String(item.type ?? '') }));

  if (!candidates.length) return [];

  const avail = await fetchContentAvailability(candidates.map(c => c.id));
  const availMap = new Map(avail.map(a => [a.contentId, a]));

  return candidates
    .map(c => {
      const a = availMap.get(c.id);
      const daysLeft = a ? daysUntil(a.availability_ends) : null;
      const startsIn = a ? daysUntil(a.availability_starts) : null;
      return {
        contentId: c.id, title: c.title, year: c.year,
        type: c.type === 's' ? 'Series' : 'Movie',
        availability_starts: a?.availability_starts ?? null,
        availability_ends: a?.availability_ends ?? null,
        daysLeft, startsIn,
      };
    })
    .filter(c => c.daysLeft === null || c.daysLeft > 30)
    .sort((a, b) => (b.daysLeft ?? 999) - (a.daysLeft ?? 999))
    .slice(0, 3);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Returns all articles instantly from local JSON — no Tubi API call
router.get('/monitor/articles', (_req: Request, res: Response) => {
  try {
    const all = loadAllArticles();
    const articles = all.map(article => ({
      id: article.id, slug: article.slug, articleType: article.articleType,
      title: article.title, subtitle: article.subtitle,
      itemCount: article.items.length,
      items: article.items,
    }));
    res.json({ articles });
  } catch (err) {
    console.error('Monitor error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Check availability for a single article's content IDs on demand
router.post('/monitor/check-availability', async (req: Request, res: Response) => {
  const { contentIds } = req.body as { contentIds: string[] };
  if (!Array.isArray(contentIds) || !contentIds.length) {
    res.json({ items: [] }); return;
  }
  try {
    const availability = await fetchContentAvailability(contentIds);
    const availMap = new Map(availability.map(a => [a.contentId, a]));
    const items = contentIds.map(id => {
      const avail = availMap.get(id);
      const foundInApi = avail !== undefined;
      const daysLeft = avail ? daysUntil(avail.availability_ends) : null;
      const startsIn = avail ? daysUntil(avail.availability_starts) : null;
      return {
        contentId: id,
        availability_starts: avail?.availability_starts ?? null,
        availability_ends: avail?.availability_ends ?? null,
        daysLeft,
        startsIn,
        status: expiryStatus(daysLeft, foundInApi, startsIn),
      };
    });
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/monitor/regenerate', async (req: Request, res: Response) => {
  const { entryTitle, contentTitle, contentType, articleTitle } = req.body as {
    entryTitle: string; contentTitle: string; contentType: string; articleTitle: string;
  };
  if (!entryTitle || !contentTitle || !articleTitle) {
    res.status(400).json({ error: 'entryTitle, contentTitle, articleTitle required' }); return;
  }
  try {
    const blurb = await regenerateBlurb(entryTitle, contentTitle, contentType || 'title', articleTitle);
    res.json({ blurb });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/monitor/suggest-replacement', async (req: Request, res: Response) => {
  const { contentTitle, contentType, articleTitle, contentId, isComingSoon } = req.body as {
    contentTitle: string; contentType: string; articleTitle: string; contentId?: string; isComingSoon?: boolean;
  };
  if (!contentTitle || !articleTitle) {
    res.status(400).json({ error: 'contentTitle and articleTitle required' }); return;
  }
  try {
    const query = articleTitle.replace(/\b(best|top|free|on tubi|right now|this (week|weekend|month))\b/gi, '').trim() || contentTitle;
    const suggestions = await searchTubiForSuggestions(query, contentId ?? null, isComingSoon ?? false);
    res.json({ suggestions });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
