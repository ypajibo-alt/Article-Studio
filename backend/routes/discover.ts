import { Router, Request, Response } from 'express';
import { fetchAllContainers, fetchContainerTitles } from '../lib/tubiSearch.js';
import { fetchContentAvailability } from '../lib/tubi.js';
import { selectContainersWithOpenAI, selectTitlesWithOpenAI } from '../lib/bedrock.js';
import { loadPrompt } from '../lib/prompts.js';
import { sse } from '../lib/sse.js';
import { AVAILABILITY_WINDOW_MS } from '../lib/config.js';

const router = Router();

function fisherYatesShuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

router.post('/discover', async (req: Request, res: Response) => {
  const { angle, publishDate } = req.body as { angle: string; publishDate?: string };

  if (!angle || angle.trim().length < 5) {
    res.status(400).json({ error: 'angle is required (min 5 chars)' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    // ── Stage 1: Fetch all containers ────────────────────────────────────────
    sse(res, { type: 'stage', stage: 'containers', label: 'Loading Tubi containers…' });
    const allContainers = await fetchAllContainers();
    if (!allContainers.length) {
      sse(res, { type: 'error', message: 'Could not fetch Tubi containers' });
      res.end(); return;
    }
    sse(res, { type: 'containers_loaded', count: allContainers.length });

    // ── Stage 2: OpenAI picks best containers for the angle ───────────────────
    sse(res, { type: 'stage', stage: 'match', label: 'Selecting best containers for angle…' });

    // Pass containers with their API position (index = recency/featured order)
    const containersWithPosition = allContainers.map((c, i) => ({
      id: c.id,
      title: c.title,
      subtitle: c.subtitle || '',
      position: i + 1,
    }));

    let selectedIds: string[] = [];
    try {
      selectedIds = await selectContainersWithOpenAI(angle.trim(), containersWithPosition);
    } catch (err) {
      sse(res, { type: 'error', message: `Container selection failed: ${(err as Error).message}` });
      res.end(); return;
    }

    // Fall back to first 3 if OpenAI returned nothing
    const toFetch = selectedIds.length
      ? allContainers.filter(c => selectedIds.includes(c.id)).slice(0, 7)
      : allContainers.slice(0, 5);

    sse(res, { type: 'matched', containers: toFetch.map(c => ({ id: c.id, title: c.title })) });

    // ── Stage 3: Fetch titles from selected containers (parallel) ─────────────
    sse(res, { type: 'stage', stage: 'titles', label: `Fetching titles from ${toFetch.length} containers…` });

    const results = await Promise.all(
      toFetch.map(c => fetchContainerTitles(c.id, 100).catch(() => null))
    );

    const seenIds = new Set<string>();
    const candidates: { id: string; title: string; year: number; type: string; description: string }[] = [];

    for (const data of results) {
      if (!data) continue;
      for (const t of data.titles) {
        if (!seenIds.has(t.id)) {
          seenIds.add(t.id);
          candidates.push({ id: t.id, title: t.title, year: t.year, type: t.type, description: t.description });
        }
      }
    }

    if (candidates.length < 5) {
      sse(res, { type: 'error', message: 'Not enough titles found. Try a broader angle.' });
      res.end(); return;
    }

    // Filter by format if the angle is explicit — but only if enough candidates survive
    const angleLower = angle.toLowerCase();
    const wantsMovies = /\b(movie|movies|film|films)\b/.test(angleLower);
    const wantsSeries = /\b(show|shows|series|tv)\b/.test(angleLower);
    const filtered = wantsMovies
      ? candidates.filter(t => t.type !== 's')
      : wantsSeries
        ? candidates.filter(t => t.type === 's')
        : candidates;

    // Sort by year desc, then shuffle so repeated runs surface different titles
    const preshuffle = fisherYatesShuffle(
      filtered.sort((a, b) => (b.year || 0) - (a.year || 0)).slice(0, 150)
    ).slice(0, 60);

    // ── Stage 3b: Fetch availability + filter by publish date ─────────────────
    sse(res, { type: 'stage', stage: 'titles', label: 'Checking title availability…' });

    const availMap = new Map<string, { ends: string | null }>();
    try {
      const avail = await fetchContentAvailability(preshuffle.map(t => t.id));
      for (const a of avail) availMap.set(a.contentId, { ends: a.availability_ends });
    } catch {
      // non-fatal — proceed without availability data
    }

    // Soft-filter by availability — if too few survive, fall back to full pool
    // Availability is shown on cards regardless so editor can make final call
    const cutoff = publishDate
      ? new Date(new Date(publishDate).getTime() + AVAILABILITY_WINDOW_MS)
      : null;

    const available = cutoff
      ? preshuffle.filter(t => {
          const av = availMap.get(t.id);
          if (!av) return true;       // unknown — keep
          if (!av.ends) return true;  // always available
          return new Date(av.ends) >= cutoff;
        })
      : preshuffle;

    // Fall back to full pool if filter was too aggressive
    const sorted = available.length >= 10 ? available : preshuffle;
    sse(res, { type: 'candidates', count: sorted.length });

    // ── Stage 4: OpenAI selects the best 10 titles ────────────────────────────
    sse(res, { type: 'stage', stage: 'select', label: 'Selecting best titles for angle…' });

    const discoverPrompt = await loadPrompt('discover-prompt.md');
    const candidatesList = sorted.map(t =>
      `- id:${t.id} | ${t.title} (${t.year || '?'}) [${t.type === 's' ? 'Series' : 'Movie'}] — ${t.description.slice(0, 80)}`
    ).join('\n');

    let selected: { id: string; title: string; reason: string }[] = [];
    try {
      selected = await selectTitlesWithOpenAI(angle.trim(), candidatesList, discoverPrompt);
    } catch (err) {
      sse(res, { type: 'error', message: `Title selection failed: ${(err as Error).message}` });
      res.end(); return;
    }

    if (selected.length < 5) {
      sse(res, { type: 'error', message: 'AI could not find enough relevant titles. Try a more specific angle.' });
      res.end(); return;
    }

    const candidateMap = new Map(candidates.map(c => [c.id, c]));
    const enriched = selected.map(s => {
      const av = availMap.get(s.id);
      return {
        ...s,
        year: candidateMap.get(s.id)?.year ?? null,
        type: candidateMap.get(s.id)?.type === 's' ? 'series' : 'movie',
        description: candidateMap.get(s.id)?.description ?? '',
        availabilityEnds: av?.ends ?? null,
      };
    });

    sse(res, { type: 'done', selected: enriched });

  } catch (err) {
    sse(res, { type: 'error', message: (err as Error).message });
  }

  res.end();
});

export default router;
