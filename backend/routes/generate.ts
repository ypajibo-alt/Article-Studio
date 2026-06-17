import { Router, Request, Response } from 'express';
import { callAI, MAX_RETRIES, runBrandCheck } from '../lib/bedrock.js';
import { loadPrompt, fillTemplate } from '../lib/prompts.js';
import { fetchFullMetadata, formatCastList, type FullMetadata } from '../lib/tubiSearch.js';
import {
  parseArticleJSON, runArticleQualityGate, serializeArticleOutput,
  parseListicleJSON, runListicleQualityGate, serializeListicleOutput,
} from '../lib/quality-gate.js';
import { writeArticle, slugify, getUniqueSlug, type SavedArticle } from '../lib/storage.js';
import { sse } from '../lib/sse.js';

const router = Router();

// ── Shared generation pipeline ────────────────────────────────────────────────

interface ArticleGenerationConfig {
  promptFiles: { system: string; user: string };
  templateVars: Record<string, string>;
  articleType: 'single' | 'coming-soon';
  meta: FullMetadata;
  contentId: string;
}

async function runArticleGenerationPipeline(
  emit: (data: object) => void,
  config: ArticleGenerationConfig,
): Promise<void> {
  emit({ type: 'stage', stage: 'prompts', label: 'Building prompt…' });

  const [systemPrompt, userTemplate, brandVoiceRef, brandAlignPrompt] = await Promise.all([
    loadPrompt(config.promptFiles.system),
    loadPrompt(config.promptFiles.user),
    loadPrompt('brand-voice-reference.md'),
    loadPrompt('brand-alignment-prompt.md'),
  ]);

  let output = null;
  let finalBrandScore: number | null = null;
  let finalBrandNotes = '';
  let retryFeedback = '';

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    emit({ type: 'stage', stage: 'generate', label: `Generating (attempt ${attempt}/${MAX_RETRIES + 1})…` });

    let raw: string;
    try {
      raw = await callAI(systemPrompt, fillTemplate(userTemplate, {
        ...config.templateVars,
        retry_feedback: retryFeedback,
      }));
    } catch (err) {
      retryFeedback = `## Retry feedback\nAI call failed: ${(err as Error).message}`;
      if (attempt > MAX_RETRIES) { emit({ type: 'error', message: 'AI generation failed after all retries' }); return; }
      continue;
    }

    let parsed;
    try { parsed = parseArticleJSON(raw); }
    catch {
      retryFeedback = '## Retry feedback\nPrevious response was not valid JSON. Return only a JSON object.';
      continue;
    }

    emit({ type: 'stage', stage: 'quality', label: 'Running quality gate…' });
    const quality = runArticleQualityGate(parsed);
    if (!quality.passed) {
      retryFeedback = `## Retry feedback\n${quality.retryFeedback.map(f => `- ${f}`).join('\n')}`;
      emit({ type: 'quality_fail', issues: quality.retryFeedback, attempt });
      continue;
    }

    const fixed = quality.autoFixed;

    emit({ type: 'stage', stage: 'brand', label: 'Brand voice check…' });
    try {
      const brand = await runBrandCheck(serializeArticleOutput(fixed), brandVoiceRef, brandAlignPrompt);
      finalBrandScore = brand.overall;
      finalBrandNotes = brand.notes;
      if (!brand.passed && attempt <= MAX_RETRIES) {
        retryFeedback = `## Retry feedback\nBrand score ${brand.overall.toFixed(1)}/5.0 (need 3.5+). ${brand.notes}`;
        emit({ type: 'brand_fail', score: brand.overall, notes: brand.notes, attempt });
        continue;
      }
    } catch {
      // brand check failure is non-blocking
    }

    output = fixed;
    break;
  }

  if (!output) {
    emit({ type: 'error', message: 'Article failed all quality checks. Try again or adjust the title.' });
    return;
  }

  emit({ type: 'stage', stage: 'save', label: 'Saving to Articles…' });
  const slug = getUniqueSlug(slugify(output.headline || config.meta.title));
  const now = new Date().toISOString();
  const article: SavedArticle = {
    slug, createdAt: now, updatedAt: now,
    status: 'draft', published: false, publishedAt: null, publishAt: null,
    articleType: config.articleType, articleTitle: config.meta.title,
    tags: config.meta.tags,
    heroImageUrl: config.meta.posterart,
    secondaryImageUrls: config.meta.landscape ? [config.meta.landscape] : [],
    contentId: config.contentId,
    brandScore: finalBrandScore, brandNotes: finalBrandNotes,
    gscQueries: [],
    seo: { metaTitle: output.headline, metaDescription: output.subheadline, canonicalUrl: '' },
    output: output as unknown as Record<string, unknown>,
    blocks: [], comments: [],
  };
  writeArticle(article);
  emit({ type: 'done', slug, brandScore: finalBrandScore, brandNotes: finalBrandNotes });
}

// ── Single title ──────────────────────────────────────────────────────────────

async function generateSingleWithEmit(emit: (data: object) => void, contentId: string): Promise<void> {
  emit({ type: 'stage', stage: 'metadata', label: 'Fetching title metadata from Tubi…' });

  const meta = await fetchFullMetadata(contentId);
  if (!meta) { emit({ type: 'error', message: `Could not fetch metadata for content ID ${contentId}` }); return; }
  emit({ type: 'metadata', title: meta.title, year: meta.year, contentType: meta.type === 's' ? 'Series' : 'Movie' });

  const rating = meta.ratings.find(r => r.system === 'mpaa')?.rating
    ?? meta.ratings.find(r => r.system === 'tvpg')?.rating
    ?? meta.ratings[0]?.rating
    ?? 'Not Rated';

  await runArticleGenerationPipeline(emit, {
    promptFiles: { system: 'article-system-prompt.md', user: 'article-user-prompt.md' },
    templateVars: {
      title: meta.title, year: String(meta.year),
      type: meta.type === 's' ? 'TV Series' : 'Movie',
      description: meta.description,
      directors: meta.directors.join(', ') || 'Unknown',
      cast_list: formatCastList(meta.cast),
      tags: meta.tags.join(', ') || 'None',
      rating,
    },
    articleType: 'single',
    meta,
    contentId,
  });
}

// ── Coming Soon ───────────────────────────────────────────────────────────────

async function generateComingSoonWithEmit(emit: (data: object) => void, contentId: string, releaseDate?: string): Promise<void> {
  emit({ type: 'stage', stage: 'metadata', label: 'Fetching title metadata from Tubi…' });

  const meta = await fetchFullMetadata(contentId);
  if (!meta) { emit({ type: 'error', message: `Could not fetch metadata for content ID ${contentId}` }); return; }
  emit({ type: 'metadata', title: meta.title, year: meta.year, contentType: meta.type === 's' ? 'Series' : 'Movie' });

  const rating = meta.ratings.find(r => r.system === 'mpaa')?.rating
    ?? meta.ratings.find(r => r.system === 'tvpg')?.rating
    ?? meta.ratings[0]?.rating
    ?? 'Not Rated';

  await runArticleGenerationPipeline(emit, {
    promptFiles: { system: 'coming-soon-system-prompt.md', user: 'coming-soon-user-prompt.md' },
    templateVars: {
      title: meta.title, year: String(meta.year),
      type: meta.type === 's' ? 'TV Series' : 'Movie',
      description: meta.description,
      directors: meta.directors.join(', ') || 'Unknown',
      cast_list: formatCastList(meta.cast),
      tags: meta.tags.join(', ') || 'None',
      rating,
      release_date: releaseDate || 'Coming soon',
    },
    articleType: 'coming-soon',
    meta,
    contentId,
  });
}

// ── Listicle ──────────────────────────────────────────────────────────────────

async function generateListicle(
  res: Response,
  angle: string,
  titles: { id: string; title: string; year?: number; description?: string; posterart?: string; tags?: string[] }[],
): Promise<void> {
  sse(res, { type: 'stage', stage: 'metadata', label: `Building listicle for ${titles.length} titles…` });
  sse(res, { type: 'metadata', title: angle, year: null, contentType: 'Listicle' });

  sse(res, { type: 'stage', stage: 'prompts', label: 'Building prompt…' });
  const [systemPrompt, userTemplate, brandVoiceRef, brandAlignPrompt] = await Promise.all([
    loadPrompt('listicle-system-prompt.md'),
    loadPrompt('listicle-user-prompt.md'),
    loadPrompt('brand-voice-reference.md'),
    loadPrompt('brand-alignment-prompt.md'),
  ]);

  const titlesList = titles.map(t => {
    const parts = [`contentId:${t.id}`, t.title];
    if (t.year) parts.push(`(${t.year})`);
    if (t.tags?.length) parts.push(`[${t.tags.join(', ')}]`);
    if (t.description) parts.push(`— ${t.description.slice(0, 150)}`);
    return `- ${parts.join(' ')}`;
  }).join('\n');

  let output = null;
  let finalBrandScore: number | null = null;
  let finalBrandNotes = '';
  let retryFeedback = '';

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    sse(res, { type: 'stage', stage: 'generate', label: `Generating (attempt ${attempt}/${MAX_RETRIES + 1})…` });

    let raw: string;
    try {
      raw = await callAI(systemPrompt, fillTemplate(userTemplate, {
        container_name: angle.trim(),
        container_description: angle.trim().startsWith('Derive your own')
          ? 'Derive the angle and headline from the titles — find what connects them.'
          : `A curated watchlist based on: ${angle.trim()}`,
        title_count: String(titles.length),
        title_list: titlesList,
        retry_feedback: retryFeedback,
      }));
    } catch (err) {
      retryFeedback = `## Retry feedback\nAI call failed: ${(err as Error).message}`;
      if (attempt > MAX_RETRIES) { sse(res, { type: 'error', message: 'AI generation failed after all retries' }); res.end(); return; }
      continue;
    }

    let parsed;
    try { parsed = parseListicleJSON(raw); }
    catch (err) {
      retryFeedback = '## Retry feedback\nPrevious response was not valid JSON. Return only a JSON object.';
      sse(res, { type: 'quality_fail', issues: [`JSON parse error: ${(err as Error).message}. Raw length: ${raw.length}`], attempt });
      if (attempt > MAX_RETRIES) { sse(res, { type: 'error', message: 'AI returned invalid JSON after all retries' }); res.end(); return; }
      continue;
    }

    sse(res, { type: 'stage', stage: 'quality', label: 'Running quality gate…' });
    const validIds = new Set(titles.map(t => t.id));
    const quality = runListicleQualityGate(parsed, validIds);
    if (!quality.passed) {
      retryFeedback = `## Retry feedback\n${quality.retryFeedback.map(f => `- ${f}`).join('\n')}`;
      sse(res, { type: 'quality_fail', issues: quality.retryFeedback, attempt });
      continue;
    }

    const fixed = quality.autoFixed;

    sse(res, { type: 'stage', stage: 'brand', label: 'Brand voice check…' });
    try {
      const brand = await runBrandCheck(serializeListicleOutput(fixed), brandVoiceRef, brandAlignPrompt);
      finalBrandScore = brand.overall;
      finalBrandNotes = brand.notes;
      if (!brand.passed && attempt <= MAX_RETRIES) {
        retryFeedback = `## Retry feedback\nBrand score ${brand.overall.toFixed(1)}/5.0 (need 3.5+). ${brand.notes}`;
        sse(res, { type: 'brand_fail', score: brand.overall, notes: brand.notes, attempt });
        continue;
      }
    } catch {
      // brand check failure is non-blocking
    }

    output = fixed;
    break;
  }

  if (!output) {
    sse(res, { type: 'error', message: 'Listicle failed all quality checks. Try again or adjust the angle.' });
    res.end(); return;
  }

  sse(res, { type: 'stage', stage: 'save', label: 'Saving to Articles…' });
  const slug = getUniqueSlug(slugify(output.headline || angle));
  const now = new Date().toISOString();
  const allTags = [...new Set(titles.flatMap(t => t.tags ?? []))];
  const article: SavedArticle = {
    slug, createdAt: now, updatedAt: now,
    status: 'draft', published: false, publishedAt: null, publishAt: null,
    articleType: 'listicle', articleTitle: output.headline || angle,
    tags: allTags,
    heroImageUrl: titles[0]?.posterart || '',
    secondaryImageUrls: [],
    contentId: null, brandScore: finalBrandScore, brandNotes: finalBrandNotes,
    gscQueries: [],
    seo: { metaTitle: output.headline, metaDescription: output.subtitle || output.angle, canonicalUrl: '' },
    output: output as unknown as Record<string, unknown>,
    blocks: [], comments: [],
  };
  writeArticle(article);
  sse(res, { type: 'done', slug, brandScore: finalBrandScore, brandNotes: finalBrandNotes });
}

// ── Bulk route ────────────────────────────────────────────────────────────────

router.post('/generate/bulk', async (req: Request, res: Response) => {
  const { items } = req.body as {
    items: { contentId: string; mode: 'single' | 'coming-soon'; releaseDate?: string }[];
  };

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'items array is required' });
    return;
  }

  for (const item of items) {
    if (!item.contentId || (item.mode !== 'single' && item.mode !== 'coming-soon')) {
      res.status(400).json({ error: `Invalid item: ${JSON.stringify(item)}` });
      return;
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const total = items.length;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const emit = (data: object) => sse(res, { ...data, bulkIndex: i, bulkTotal: total });

    emit({ type: 'bulk_item_start', contentId: item.contentId, mode: item.mode });

    try {
      if (item.mode === 'single') {
        await generateSingleWithEmit(emit, item.contentId);
      } else {
        await generateComingSoonWithEmit(emit, item.contentId, item.releaseDate);
      }
    } catch (err) {
      emit({ type: 'error', message: (err as Error).message });
    }

    emit({ type: 'bulk_item_end', contentId: item.contentId, index: i, total });
  }

  sse(res, { type: 'bulk_done', total });
  res.end();
});

// ── Route ─────────────────────────────────────────────────────────────────────

router.post('/generate', async (req: Request, res: Response) => {
  const { mode, contentId, angle, titles, releaseDate } = req.body as {
    mode: string;
    contentId?: string;
    angle?: string;
    titles?: { id: string; title: string; year?: number; description?: string; posterart?: string; tags?: string[] }[];
    releaseDate?: string;
  };

  if (mode !== 'single' && mode !== 'listicle' && mode !== 'coming-soon') {
    res.status(400).json({ error: 'mode must be single, listicle, or coming-soon' });
    return;
  }
  if ((mode === 'single' || mode === 'coming-soon') && !contentId) {
    res.status(400).json({ error: 'contentId is required for this mode' });
    return;
  }
  if (mode === 'listicle' && (!angle || !titles || titles.length < 5)) {
    res.status(400).json({ error: 'angle and at least 5 titles are required for mode=listicle' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    if (mode === 'single') {
      await generateSingleWithEmit(data => sse(res, data), contentId!);
    } else if (mode === 'coming-soon') {
      await generateComingSoonWithEmit(data => sse(res, data), contentId!, releaseDate);
    } else {
      await generateListicle(res, angle!, titles!);
    }
    res.end();
  } catch (err) {
    sse(res, { type: 'error', message: (err as Error).message });
    res.end();
  }
});

export default router;
