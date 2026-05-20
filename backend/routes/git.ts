import { Router, Request, Response } from 'express';
import simpleGit from 'simple-git';

const router = Router();

const REPO_PATH = '/Users/ypajibo/Downloads/Growth /Official Blog Directory/V2-Blog-main';
const git = simpleGit(REPO_PATH);

router.get('/git/status', async (_req: Request, res: Response) => {
  try {
    const status = await git.status();
    const log = await git.log(['--oneline', '-5']);

    const files = [
      ...status.modified.map(f => ({ path: f, status: 'M' })),
      ...status.not_added.map(f => ({ path: f, status: '??' })),
      ...status.created.map(f => ({ path: f, status: 'A' })),
      ...status.deleted.map(f => ({ path: f, status: 'D' })),
      ...status.renamed.map(f => ({ path: typeof f === 'string' ? f : f.to, status: 'R' })),
      ...status.staged.filter(f =>
        !status.modified.includes(f) && !status.created.includes(f)
      ).map(f => ({ path: f, status: 'M' })),
    ];

    // Deduplicate
    const seen = new Set<string>();
    const uniqueFiles = files.filter(f => {
      if (seen.has(f.path)) return false;
      seen.add(f.path);
      return true;
    });

    res.json({
      branch: status.current,
      ahead: status.ahead,
      behind: status.behind,
      files: uniqueFiles,
      recentCommits: log.all.map(c => ({ hash: c.hash.slice(0, 7), message: c.message })),
    });
  } catch (err) {
    console.error('Git status error:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/git/commit', async (req: Request, res: Response) => {
  const { message, files } = req.body as { message: string; files: string[] };
  if (!message || !files?.length) {
    res.status(400).json({ error: 'message and files required' });
    return;
  }

  try {
    await git.add(files);
    const result = await git.commit(message);
    res.json({ success: true, commit: result.commit, summary: result.summary });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/git/push', async (_req: Request, res: Response) => {
  try {
    const status = await git.status();
    const branch = status.current ?? 'main';
    await git.push('origin', branch);
    res.json({ success: true, branch });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
