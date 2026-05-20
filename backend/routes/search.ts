import { Router, Request, Response } from 'express';
import { searchTubi, fetchAllContainers, fetchContainerTitles } from '../lib/tubiSearch.js';

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
    const data = await fetchContainerTitles(id, 50);
    if (!data) { res.status(404).json({ error: 'Container not found' }); return; }
    res.json({ containerTitle: data.containerName, titles: data.titles.map(t => ({ id: t.id, title: t.title, year: t.year, type: t.type })) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
