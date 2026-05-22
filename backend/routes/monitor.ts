import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchContentAvailability, extractContentId, getToken } from '../lib/tubi.js';
import { regenerateBlurb } from '../lib/bedrock.js';

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
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86_400_000);
}

function expiryStatus(daysLeft: number | null, foundInApi: boolean): 'expired' | 'critical' | 'warning' | 'ok' | 'unknown' {
  if (!foundInApi) return 'unknown';
  if (daysLeft === null) return 'ok';
  if (daysLeft < 0) return 'expired';
  if (daysLeft <= 7) return 'critical';
  if (daysLeft <= 30) return 'warning';
  return 'ok';
}

function articleStatus(items: TrackableItem[]): 'critical' | 'warning' | 'ok' | 'unknown' {
  if (!items.length) return 'unknown';
  const critical = items.filter(i => i.status === 'critical' || i.status === 'expired').length;
  const warning = items.filter(i => i.status === 'warning').length;
  const unknown = items.filter(i => i.status === 'unknown').length;
  if (critical > 0) return 'critical';
  if (warning > 0) return 'warning';
  if (unknown === items.length) return 'unknown';
  return 'ok';
}

// ─── Replacement suggestions ──────────────────────────────────────────────────

async function searchTubiForSuggestions(
  query: string,
  excludeContentId: string | null,
): Promise<Array<{ contentId: string; title: string; year: number | null; type: string; availability_ends: string | null; daysLeft: number | null }>> {
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
      return {
        contentId: c.id, title: c.title, year: c.year,
        type: c.type === 's' ? 'Series' : 'Movie',
        availability_ends: a?.availability_ends ?? null, daysLeft,
      };
    })
    .filter(c => c.daysLeft === null || c.daysLeft > 30)
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
      return {
        contentId: id,
        availability_ends: avail?.availability_ends ?? null,
        daysLeft,
        status: expiryStatus(daysLeft, foundInApi),
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
  const { contentTitle, contentType, articleTitle, contentId } = req.body as {
    contentTitle: string; contentType: string; articleTitle: string; contentId?: string;
  };
  if (!contentTitle || !articleTitle) {
    res.status(400).json({ error: 'contentTitle and articleTitle required' }); return;
  }
  try {
    const query = articleTitle.replace(/\b(best|top|free|on tubi|right now|this (week|weekend|month))\b/gi, '').trim() || contentTitle;
    const suggestions = await searchTubiForSuggestions(query, contentId ?? null);
    res.json({ suggestions });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
