import { Router, Request, Response } from 'express';
import { searchTubi, fetchAllContainers, fetchContainerTitles, fetchFullMetadata } from '../lib/tubiSearch.js';
import { fetchContentAvailability } from '../lib/tubi.js';

const router = Router();

router.get('/search', async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) { res.json([]); return; }
  try {
    res.json(await searchTubi(q, 12));
  } catch {
    res.json([]);
  }
});

router.get('/containers', async (_req: Request, res: Response) => {
  try {
    res.json(await fetchAllContainers());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/container-titles', async (req: Request, res: Response) => {
  const id = String(req.query.id ?? '').trim();
  if (!id) { res.status(400).json({ error: 'id required' }); return; }
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const data = await fetchContainerTitles(id, limit);
    if (!data) { res.status(404).json({ error: 'Container not found' }); return; }
    res.json({ containerTitle: data.containerName, titles: data.titles.map(t => ({ id: t.id, title: t.title, year: t.year, type: t.type })) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/metadata', async (req: Request, res: Response) => {
  const contentId = String(req.query.contentId ?? '').trim();
  if (!contentId) { res.status(400).json({ error: 'contentId required' }); return; }
  try {
    const meta = await fetchFullMetadata(contentId);
    if (!meta) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ id: meta.id, title: meta.title, year: meta.year, type: meta.type, description: meta.description, posterart: meta.posterart });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/availability', async (req: Request, res: Response) => {
  const { contentIds } = req.body as { contentIds?: string[] };
  if (!Array.isArray(contentIds) || !contentIds.length) { res.json([]); return; }
  try {
    res.json(await fetchContentAvailability(contentIds.slice(0, 200)));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
