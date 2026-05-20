import { Router, Request, Response } from 'express';
import fs from 'fs';
import { fetchContentAvailability, extractContentId, getToken } from '../lib/tubi.js';
import { regenerateBlurb } from '../lib/bedrock.js';

const router = Router();

const BASE = '/Users/ypajibo/Downloads/Growth /Official Blog Directory/V2-Blog-main/Official Article Generation Pipeline/Static Upload Tubi Blog';
const LISTICLES_PATH = `${BASE}/Refreshed Items/Actual Updated Content/listicles-refreshed.json`;
const SINGLES_PATH = `${BASE}/single-titles.json`;
const WORLDCUP_PATH = `${BASE}/world-cup.json`;

// ─── Unified article shape ───────────────────────────────────────────────────

interface TrackableItem {
  position: number;
  title: string;
  description?: string;
  content_title?: string;
  content_type?: string;
  tubi_link: string;
  contentId: string | null;
  images?: Record<string, unknown>;
  // filled after API fetch:
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
  images?: Record<string, unknown>;
  items: TrackableItem[];
}

function readJSON(path: string): unknown {
  try { return JSON.parse(fs.readFileSync(path, 'utf-8')); }
  catch (e) { console.error(`Failed to read ${path}:`, e); return null; }
}

function loadAllArticles(): UnifiedArticle[] {
  const articles: UnifiedArticle[] = [];

  // ── Listicles ──
  const listiclesRaw = readJSON(LISTICLES_PATH);
  const listicles: Record<string, unknown>[] = Array.isArray(listiclesRaw)
    ? listiclesRaw
    : ((listiclesRaw as Record<string, unknown>)?.articles as Record<string, unknown>[]) ?? [];

  for (const a of listicles) {
    const items: TrackableItem[] = ((a.items as Record<string, unknown>[]) ?? []).map((item, idx) => ({
      position: (item.position as number) ?? idx + 1,
      title: String(item.title ?? ''),
      description: String(item.description ?? ''),
      content_title: String(item.content_title ?? ''),
      content_type: String(item.content_type ?? ''),
      tubi_link: String(item.tubi_link ?? ''),
      contentId: extractContentId(String(item.tubi_link ?? '')),
      images: item.images as Record<string, unknown>,
    }));
    articles.push({
      id: String(a.id ?? ''),
      slug: String(a.slug ?? ''),
      articleType: 'listicle',
      title: String(a.title ?? ''),
      subtitle: String(a.subtitle ?? ''),
      images: a.images as Record<string, unknown>,
      items,
    });
  }

  // ── Single titles ──
  const singlesRaw = readJSON(SINGLES_PATH);
  const singles: Record<string, unknown>[] = Array.isArray(singlesRaw) ? singlesRaw : [];

  for (const a of singles) {
    const link = String(a.watch_link ?? '');
    const contentId = extractContentId(link);
    const items: TrackableItem[] = link && contentId ? [{
      position: 1,
      title: String(a.title ?? ''),
      description: String(a.subtitle ?? a.intro_paragraph ?? ''),
      content_title: String(a.title ?? ''),
      content_type: 'Single Title',
      tubi_link: link,
      contentId,
    }] : [];
    articles.push({
      id: String(a.id ?? ''),
      slug: String(a.slug ?? ''),
      articleType: 'single',
      title: String(a.title ?? ''),
      subtitle: String(a.subtitle ?? ''),
      items,
    });
  }

  // ── World Cup ──
  const wcRaw = readJSON(WORLDCUP_PATH);
  const wc: Record<string, unknown>[] = Array.isArray(wcRaw) ? wcRaw : [];

  for (const a of wc) {
    // No real watch_links in world cup data — these are editorial guides
    articles.push({
      id: String(a.id ?? ''),
      slug: String(a.slug ?? ''),
      articleType: 'worldcup',
      title: String(a.title ?? ''),
      subtitle: String(a.subtitle ?? ''),
      items: [],
    });
  }

  return articles;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Tubi search for replacement suggestions ─────────────────────────────────

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

  // Fetch availability for candidates
  const avail = await fetchContentAvailability(candidates.map(c => c.id));
  const availMap = new Map(avail.map(a => [a.contentId, a]));

  return candidates
    .map(c => {
      const a = availMap.get(c.id);
      const daysLeft = a ? daysUntil(a.availability_ends) : null;
      return {
        contentId: c.id,
        title: c.title,
        year: c.year,
        type: c.type === 's' ? 'Series' : 'Movie',
        availability_ends: a?.availability_ends ?? null,
        daysLeft,
      };
    })
    // Filter out titles also expiring within 30 days or already expired
    .filter(c => c.daysLeft === null || c.daysLeft > 30)
    .slice(0, 3);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get('/monitor/articles', async (_req: Request, res: Response) => {
  try {
    const all = loadAllArticles();

    // Collect all trackable content IDs
    const allIds = [...new Set(
      all.flatMap(a => a.items.map(i => i.contentId).filter(Boolean) as string[])
    )];

    const availability = await fetchContentAvailability(allIds);
    const availMap = new Map(availability.map(a => [a.contentId, a]));

    const articles = all.map(article => {
      const items = article.items.map(item => {
        const avail = item.contentId ? availMap.get(item.contentId) : undefined;
        const foundInApi = avail !== undefined;
        const daysLeft = avail ? daysUntil(avail.availability_ends) : null;
        const status = expiryStatus(daysLeft, foundInApi);
        return { ...item, availability_starts: avail?.availability_starts ?? null, availability_ends: avail?.availability_ends ?? null, daysLeft, status };
      });

      const criticalCount = items.filter(i => i.status === 'critical' || i.status === 'expired').length;
      const warningCount = items.filter(i => i.status === 'warning').length;
      const unknownCount = items.filter(i => i.status === 'unknown').length;
      const status = article.items.length === 0 ? 'ok' : articleStatus(items as TrackableItem[]);

      return {
        id: article.id, slug: article.slug, articleType: article.articleType,
        title: article.title, subtitle: article.subtitle, images: article.images,
        itemCount: items.length, criticalCount, warningCount, unknownCount,
        status, items,
      };
    });

    res.json({ articles, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Monitor error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/monitor/regenerate — regenerate a single blurb entry
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

// POST /api/monitor/suggest-replacement — find replacement titles on Tubi
router.post('/monitor/suggest-replacement', async (req: Request, res: Response) => {
  const { contentTitle, contentType, articleTitle, contentId } = req.body as {
    contentTitle: string; contentType: string; articleTitle: string; contentId?: string;
  };
  if (!contentTitle || !articleTitle) {
    res.status(400).json({ error: 'contentTitle and articleTitle required' }); return;
  }
  try {
    // Build a search query from the article title (captures the genre/theme)
    // Try article title first (e.g. "Best Free Movies This Weekend"), then fall back to content title
    const query = articleTitle.replace(/\b(best|top|free|on tubi|right now|this (week|weekend|month))\b/gi, '').trim() || contentTitle;
    const suggestions = await searchTubiForSuggestions(query, contentId ?? null);
    res.json({ suggestions });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
