import { Router, Request, Response } from 'express';
import { callAI, MAX_RETRIES, runBrandCheck } from '../lib/bedrock.js';
import { loadPrompt, fillTemplate } from '../lib/prompts.js';
import { fetchFullMetadata, formatCastList } from '../lib/tubiSearch.js';
import {
  parseArticleJSON, runArticleQualityGate, serializeArticleOutput,
  parseListicleJSON, runListicleQualityGate, serializeListicleOutput,
} from '../lib/quality-gate.js';
import { writeArticle, slugify, getUniqueSlug, type SavedArticle } from '../lib/storage.js';

const router = Router();

function sse(res: Response, data: object): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  if (typeof (res as unknown as { flush?: () => void }).flush === 'function') {
    (res as unknown as { flush: () => void }).flush();
  }
}

// ── Single title ──────────────────────────────────────────────────────────────

async function generateSingle(
  res: Response,
  contentId: string,
): Promise<void> {
  sse(res, { type: 'stage', stage: 'metadata', label: 'Fetching title metadata from Tubi…' });

  const meta = await fetchFullMetadata(contentId);
  if (!meta) {
    sse(res, { type: 'error', message: `Could not fetch metadata for content ID ${contentId}` });
    res.end(); return;
  }
  sse(res, { type: 'metadata', title: meta.title, year: meta.year, contentType: meta.type === 's' ? 'Series' : 'Movie' });

  sse(res, { type: 'stage', stage: 'prompts', label: 'Building prompt…' });
  const [systemPrompt, userTemplate, brandVoiceRef, brandAlignPrompt] = await Promise.all([
    loadPrompt('article-system-prompt.md'),
    loadPrompt('article-user-prompt.md'),
    loadPrompt('brand-voice-reference.md'),
    loadPrompt('brand-alignment-prompt.md'),
  ]);

  const castList = formatCastList(meta.cast);
  const directors = meta.directors.join(', ') || 'Unknown';
  const tags = meta.tags.join(', ') || 'None';
  const rating = meta.ratings.find(r => r.system === 'mpaa')?.rating
    ?? meta.ratings.find(r => r.system === 'tvpg')?.rating
    ?? meta.ratings[0]?.rating
    ?? 'Not Rated';

  let output = null;
  let finalBrandScore: number | null = null;
  let finalBrandNotes = '';
  let retryFeedback = '';

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    sse(res, { type: 'stage', stage: 'generate', label: `Generating (attempt ${attempt}/${MAX_RETRIES + 1})…` });

    let raw: string;
    try {
      raw = await callAI(systemPrompt, fillTemplate(userTemplate, {
        title: meta.title, year: String(meta.year),
        type: meta.type === 's' ? 'TV Series' : 'Movie',
        description: meta.description, directors, cast_list: castList, tags, rating,
        retry_feedback: retryFeedback,
      }));
    } catch (err) {
      retryFeedback = `## Retry feedback\nAI call failed: ${(err as Error).message}`;
      if (attempt > MAX_RETRIES) { sse(res, { type: 'error', message: 'AI generation failed after all retries' }); res.end(); return; }
      continue;
    }

    let parsed;
    try { parsed = parseArticleJSON(raw); }
    catch {
      retryFeedback = '## Retry feedback\nPrevious response was not valid JSON. Return only a JSON object.';
      continue;
    }

    sse(res, { type: 'stage', stage: 'quality', label: 'Running quality gate…' });
    const quality = runArticleQualityGate(parsed);
    if (!quality.passed) {
      retryFeedback = `## Retry feedback\n${quality.retryFeedback.map(f => `- ${f}`).join('\n')}`;
      sse(res, { type: 'quality_fail', issues: quality.retryFeedback, attempt });
      continue;
    }

    const fixed = quality.autoFixed;

    sse(res, { type: 'stage', stage: 'brand', label: 'Brand voice check…' });
    try {
      const brand = await runBrandCheck(serializeArticleOutput(fixed), brandVoiceRef, brandAlignPrompt);
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
    sse(res, { type: 'error', message: 'Article failed all quality checks. Try again or adjust the title.' });
    res.end(); return;
  }

  sse(res, { type: 'stage', stage: 'save', label: 'Saving to Articles…' });
  const slug = getUniqueSlug(slugify(output.headline || meta.title));
  const now = new Date().toISOString();
  const article: SavedArticle = {
    slug, createdAt: now, updatedAt: now,
    status: 'draft', published: false, publishedAt: null, publishAt: null,
    articleType: 'single', articleTitle: meta.title,
    tags: meta.tags, heroImageUrl: meta.posterart,
    secondaryImageUrls: meta.landscape ? [meta.landscape] : [],
    contentId, brandScore: finalBrandScore, brandNotes: finalBrandNotes,
    gscQueries: [],
    seo: { metaTitle: output.headline, metaDescription: output.subheadline, canonicalUrl: '' },
    output: output as unknown as Record<string, unknown>,
    blocks: [], comments: [],
  };
  writeArticle(article);
  sse(res, { type: 'done', slug, brandScore: finalBrandScore, brandNotes: finalBrandNotes });
}

// ── Listicle ──────────────────────────────────────────────────────────────────

async function generateListicle(
  res: Response,
  angle: string,
  titles: { id: string; title: string; year?: number; description?: string; posterart?: string }[],
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

  // Build a rich title list with descriptions so AI can write specific blurbs
  const titlesList = titles.map(t => {
    const parts = [`contentId:${t.id}`, t.title];
    if (t.year) parts.push(`(${t.year})`);
    if (t.description) parts.push(`— ${t.description.slice(0, 100)}`);
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
        container_description: angle.trim().startsWith('Derive your own') ? 'Derive the angle and headline from the titles — find what connects them.' : `A curated watchlist based on: ${angle.trim()}`,
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
    const quality = runListicleQualityGate(parsed);
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
  const allTags = [...new Set(titles.map(t => t.title))];
  const heroImageUrl = titles[0]?.posterart || '';
  const article: SavedArticle = {
    slug, createdAt: now, updatedAt: now,
    status: 'draft', published: false, publishedAt: null, publishAt: null,
    articleType: 'listicle', articleTitle: output.headline || angle,
    tags: allTags, heroImageUrl,
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

// ── Route ─────────────────────────────────────────────────────────────────────

router.post('/generate', async (req: Request, res: Response) => {
  const { mode, contentId, angle, titles } = req.body as {
    mode: string;
    contentId?: string;
    angle?: string;
    titles?: { id: string; title: string; year?: number; description?: string; posterart?: string }[];
  };

  if (mode !== 'single' && mode !== 'listicle') {
    res.status(400).json({ error: 'mode must be single or listicle' });
    return;
  }
  if (mode === 'single' && !contentId) {
    res.status(400).json({ error: 'contentId is required for mode=single' });
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
      await generateSingle(res, contentId!);
    } else {
      await generateListicle(res, angle!, titles!);
    }
  } catch (err) {
    sse(res, { type: 'error', message: (err as Error).message });
    res.end();
  }
});

export default router;
