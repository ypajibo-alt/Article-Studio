import { Router, Request, Response } from 'express';
import { zipSync, strToU8 } from 'fflate';
import { readArticle, readAllArticles } from '../lib/storage.js';
import { fetchFullMetadata } from '../lib/tubiSearch.js';

const router = Router();

const NAV = {
  logoLabel: 'The T',
  links: [
    { label: 'Home', href: '/the-t' },
    { label: 'Coming Soon', href: '/the-t/coming-soon' },
    { label: 'Shows', href: '/the-t/shows' },
    { label: 'Movies', href: '/the-t/movies' },
  ],
  explore: {
    label: 'Explore',
    items: [
      { label: 'FIFA World Cup 2026', href: '/the-t/fifa-world-cup' },
      { label: 'Horror', href: '/the-t/horror' },
      { label: 'Tubi Originals', href: '/the-t/originals' },
      { label: 'Sports', href: '/the-t/sports' },
    ],
    moreGenresLabel: 'More genres',
    moreGenresHref: '/the-t/genres',
  },
  mobileMenu: { open: 'Open menu', close: 'Close menu' },
};

function nextArticleId(): string {
  const articles = readAllArticles();
  const maxExisting = 79;
  const exportedIds = articles
    .map(a => parseInt(String((a.output as Record<string, unknown>)?.exportId ?? '0'), 10))
    .filter(n => !isNaN(n) && n > 0);
  const next = exportedIds.length ? Math.max(maxExisting, ...exportedIds) + 1 : maxExisting + 1;
  return String(next).padStart(3, '0');
}

function inferCategoryTag(tags: string[], articleType: string): string {
  if (!tags.length) return articleType === 'single' ? 'Movies' : 'What to Watch';
  const t = tags[0].toLowerCase();
  if (t.includes('horror')) return 'Horror';
  if (t.includes('anime')) return 'Shows';
  if (t.includes('sport') || t.includes('soccer') || t.includes('football')) return 'Sports';
  if (t.includes('original')) return 'Originals';
  if (t.includes('coming soon') || t.includes('coming-soon')) return 'Coming Soon';
  if (t.includes('series') || t.includes('show') || t.includes('tv')) return 'Shows';
  return 'Movies';
}

function runtimeLabel(duration: number | null, type: string): string {
  if (!duration) return '';
  if (type === 's') return '';
  const totalMins = Math.round(duration / 60);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function encodeVarint(n: number): number[] {
  const out: number[] = [];
  while (n > 127) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n & 0x7f);
  return out;
}

// canvas-lb.tubitv.com encodes dimensions in a protobuf blob in the URL path.
// The API returns thumbnails (e.g. 400×574). This upgrades to full-res before download.
function upgradeCanvasUrl(url: string, maxWidth = 1920): string {
  if (!url.includes('canvas-lb.tubitv.com')) return url;
  try {
    const u = new URL(url);
    // path: /opts/{sig}/{uuid}/{proto-b64}
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'opts' || parts.length < 4) return url;

    const buf = Buffer.from(parts[3], 'base64');
    let i = 0;
    let origWidth = 0, origHeight = 0;
    const fields: { field: number; wire: number; start: number; end: number }[] = [];

    while (i < buf.length) {
      const start = i;
      const tag = buf[i++];
      const field = tag >> 3;
      const wire = tag & 0x7;
      if (wire === 0) {
        let val = 0, shift = 0;
        while (i < buf.length) { const b = buf[i++]; val |= (b & 0x7f) << shift; shift += 7; if (!(b & 0x80)) break; }
        if (field === 1) origWidth = val;
        if (field === 2) origHeight = val;
        fields.push({ field, wire, start, end: i });
      } else if (wire === 2) {
        const len = buf[i++]; i += len;
        fields.push({ field, wire, start, end: i });
      } else break;
    }

    if (!origWidth) return url;
    const scale = maxWidth / origWidth;
    const newWidth = maxWidth;
    const newHeight = origHeight ? Math.round(origHeight * scale) : 0;

    const out: number[] = [];
    for (const f of fields) {
      if (f.field === 1) {
        out.push(buf[f.start]);
        out.push(...encodeVarint(newWidth));
      } else if (f.field === 2 && newHeight) {
        out.push(buf[f.start]);
        out.push(...encodeVarint(newHeight));
      } else {
        for (let j = f.start; j < f.end; j++) out.push(buf[j]);
      }
    }

    parts[3] = Buffer.from(out).toString('base64');
    u.pathname = '/' + parts.join('/');
    return u.toString();
  } catch {
    return url;
  }
}

async function downloadImage(url: string): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const res = await fetch(upgradeCanvasUrl(url));
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch { return null; }
}

interface ImageEntry {
  zipPath: string;   // path inside the zip, e.g. "thumbnails/080_thumbnail.jpg"
  cdnUrl: string;    // where to download from
}

function buildKeepReading(selfSlug: string, selfTags: string[]): object {
  const all = readAllArticles()
    .filter(a => a.slug !== selfSlug && ['approved', 'ready', 'draft'].includes(a.status))
    .slice(0, 6);
  const tagged = all.filter(a => a.tags.some(t => selfTags.includes(t)));
  const pool = [...tagged, ...all.filter(a => !tagged.includes(a))].slice(0, 3);
  return {
    header: { title: 'Keep Reading', subtitle: 'More articles to explore' },
    items: pool.map(a => {
      const out = a.output as Record<string, unknown>;
      const relId = String((out.exportId as string) ?? '000');
      return {
        id: relId,
        slug: a.slug,
        eyebrow: 'What to Watch',
        title: String(out.headline ?? a.articleTitle),
        subtitle: String(out.subheadline ?? out.subtitle ?? ''),
        categoryTag: inferCategoryTag(a.tags, a.articleType),
        thumbnail: `/static/blog/the-t/thumbnails/${relId}_thumbnail.jpg`,
      };
    }),
  };
}

// ── Single ─────────────────────────────────────────────────────────────────────

async function buildSingle(article: ReturnType<typeof readArticle>, id: string) {
  if (!article) return null;
  const out = article.output as Record<string, unknown>;
  const contentId = article.contentId;

  let meta = null;
  if (contentId) {
    try { meta = await fetchFullMetadata(contentId); } catch { /* non-blocking */ }
  }

  const datePosted = new Date().toISOString().slice(0, 10);
  const castEntries = (out.cast as Array<{ name: string; bio: string }> ?? []).map(c => ({
    name: c.name, bio: c.bio,
  }));

  const faqItems = [];
  if (meta?.directors?.length) faqItems.push({ question: 'Who directed the film?', answer: meta.directors.join(', ') });
  const castNames = meta?.cast?.slice(0, 6).map(c => c.name).join(', ') ?? castEntries.map(c => c.name).join(', ');
  if (castNames) faqItems.push({ question: 'Who is in the cast?', answer: castNames });
  faqItems.push({ question: 'Where can I stream this?', answer: 'Watch free on Tubi' });

  const images: ImageEntry[] = [
    { zipPath: `thumbnails/${id}_thumbnail.jpg`, cdnUrl: meta?.landscape ?? '' },
    { zipPath: `heroes/${id}_hero.jpg`,          cdnUrl: meta?.heroImage ?? '' },
    { zipPath: `og/${id}_og.jpg`,                cdnUrl: meta?.landscape ?? '' },
  ];

  const galleryItems: string[] = [];
  const heroUrl = meta?.heroImage ?? '';
  // Prefer non-hero images for media shots; only fall back to hero if nothing else is available
  const mediaCandidates = [meta?.background, meta?.landscape, heroUrl]
    .filter((u): u is string => !!u)
    .filter((u, i, arr) => arr.indexOf(u) === i); // dedupe
  const nonHero = mediaCandidates.filter(u => u !== heroUrl);
  const mediaPool = nonHero.length > 0 ? nonHero : mediaCandidates;
  const mediaUrls = mediaPool.slice(0, 2);
  mediaUrls.forEach((url, i) => {
    const n = i + 1;
    images.push({ zipPath: `media/${id}_media_${n}.jpg`, cdnUrl: url });
    galleryItems.push(`/static/blog/the-t/media/${id}_media_${n}.jpg`);
  });

  const json = {
    nav: NAV,
    id,
    slug: article.slug,
    categoryTag: inferCategoryTag(article.tags, 'single'),
    type: 'article',
    title: String(out.headline ?? article.articleTitle),
    subtitle: String(out.subheadline ?? ''),
    datePosted,
    intro: String(out.introduction ?? ''),
    cast: { header: { title: 'The Cast' }, items: castEntries },
    quote: String(out.pullQuote ?? ''),
    faq: { header: { title: 'More details' }, items: faqItems },
    images: {
      thumbnail: `/static/blog/the-t/thumbnails/${id}_thumbnail.jpg`,
      hero:      `/static/blog/the-t/heroes/${id}_hero.jpg`,
      og:        `/static/blog/the-t/og/${id}_og.jpg`,
    },
    hero: {
      watchLink:    contentId ? `https://tubitv.com/movies/${contentId}` : '',
      contentId:    contentId ?? '',
      watchNowLabel: 'Watch Now',
    },
    whyWatch: {
      header: { title: 'Why Watch It' },
      body: String(out.whyWatchIt ?? ''),
    },
    gallery: {
      header: { title: 'Media Shots' },
      items: galleryItems,
    },
    keepReading: buildKeepReading(article.slug, article.tags),
  };

  return { json, images };
}

// ── Listicle ───────────────────────────────────────────────────────────────────

async function buildListicle(article: ReturnType<typeof readArticle>, id: string) {
  if (!article) return null;
  const out = article.output as Record<string, unknown>;
  const entries = (out.entries as Array<{
    contentId: string; title: string; year?: string | number; blurb: string;
  }>) ?? [];

  const metaResults = await Promise.allSettled(
    entries.map(e => e.contentId ? fetchFullMetadata(e.contentId) : Promise.resolve(null))
  );

  const datePosted = new Date().toISOString().slice(0, 10);
  const images: ImageEntry[] = [];

  const firstMeta = metaResults[0]?.status === 'fulfilled' ? metaResults[0].value : null;
  images.push({ zipPath: `thumbnails/${id}_thumbnail.jpg`, cdnUrl: firstMeta?.landscape ?? '' });
  images.push({ zipPath: `og/${id}_og.jpg`,                cdnUrl: firstMeta?.landscape ?? '' });

  const items = entries.map((entry, idx) => {
    const meta = metaResults[idx]?.status === 'fulfilled' ? metaResults[idx].value : null;
    const n = idx + 1;
    const rating = meta?.ratings?.find(r => r.system === 'mpaa' || r.system === 'tvpg')?.rating ?? '';
    const genre = meta?.tags?.[0] ?? '';
    const year = entry.year ?? meta?.year ?? '';
    const type = meta?.type === 's' ? 'series' : 'movies';
    const runtime = runtimeLabel(meta?.duration ?? null, meta?.type ?? 'v');

    images.push({ zipPath: `listicles/${id}_title_${n}_landscape.jpg`, cdnUrl: meta?.background ?? meta?.landscape ?? '' });
    images.push({ zipPath: `listicles/${id}_title_${n}_poster.jpg`,    cdnUrl: meta?.posterart ?? '' });
    images.push({ zipPath: `sidebar/${id}_title_${n}_sidebar.jpg`,     cdnUrl: meta?.landscape ?? '' });

    return {
      position: n,
      title: entry.title,
      description: entry.blurb,
      contentTitle: meta?.title ? `${meta.title}${year ? ` (${year})` : ''}` : entry.title,
      tubiLink: `https://tubitv.com/${type}/${entry.contentId}`,
      contentId: entry.contentId,
      hasVideoPlaybackSupport: true,
      images: {
        landscape: `/static/blog/the-t/listicles/${id}_title_${n}_landscape.jpg`,
        poster:    `/static/blog/the-t/listicles/${id}_title_${n}_poster.jpg`,
        sidebar:   `/static/blog/the-t/sidebar/${id}_title_${n}_sidebar.jpg`,
      },
      watchNowLabel: 'Watch Now',
      genre,
      year: String(year),
      runtime,
      rating,
    };
  });

  const json = {
    nav: NAV,
    id,
    slug: article.slug,
    categoryTag: inferCategoryTag(article.tags, 'listicle'),
    type: 'listicle',
    title: String(out.headline ?? article.articleTitle),
    subtitle: String(out.subtitle ?? out.subheadline ?? ''),
    intro: String(out.intro ?? ''),
    images: {
      thumbnail: `/static/blog/the-t/thumbnails/${id}_thumbnail.jpg`,
      og:        `/static/blog/the-t/og/${id}_og.jpg`,
    },
    items,
    keepReading: buildKeepReading(article.slug, article.tags),
    datePosted,
  };

  return { json, images };
}

// ── Routes ─────────────────────────────────────────────────────────────────────

// Download as zip: JSON + all images named and organized into folders
router.get('/export/:slug', async (req: Request, res: Response) => {
  const article = readArticle(req.params.slug);
  if (!article) { res.status(404).json({ error: 'Article not found' }); return; }

  try {
    const out = article.output as Record<string, unknown>;
    const id = String((out.exportId as string) ?? nextArticleId());

    const result = article.articleType === 'single'
      ? await buildSingle(article, id)
      : await buildListicle(article, id);

    if (!result) { res.status(500).json({ error: 'Export failed' }); return; }

    // Download all images in parallel, skip any that fail
    const downloads = await Promise.allSettled(
      result.images.map(img => downloadImage(img.cdnUrl).then(buf => ({ zipPath: img.zipPath, buf })))
    );

    const files: Record<string, Uint8Array> = {};
    files[`${article.slug}.json`] = strToU8(JSON.stringify(result.json, null, 2));
    for (const dl of downloads) {
      if (dl.status === 'fulfilled' && dl.value.buf) {
        files[dl.value.zipPath] = new Uint8Array(dl.value.buf);
      }
    }

    const zipped = zipSync(files, { level: 6 });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${article.slug}.zip"`);
    res.setHeader('Content-Length', zipped.byteLength);
    res.end(Buffer.from(zipped));
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: (err as Error).message });
  }
});

// Preview: JSON only, no zip, no image downloads
router.get('/export/:slug/preview', async (req: Request, res: Response) => {
  const article = readArticle(req.params.slug);
  if (!article) { res.status(404).json({ error: 'Article not found' }); return; }

  try {
    const out = article.output as Record<string, unknown>;
    const id = String((out.exportId as string) ?? nextArticleId());

    const result = article.articleType === 'single'
      ? await buildSingle(article, id)
      : await buildListicle(article, id);

    if (!result) { res.status(500).json({ error: 'Export failed' }); return; }
    res.json(result.json);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
