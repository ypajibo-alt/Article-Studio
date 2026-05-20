import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';

const router = Router();

const PIPELINE_DIR = '/Users/ypajibo/Downloads/Growth /Official Blog Directory/V2-Blog-main/Official Article Generation Pipeline/article-pipeline';

router.post('/pipeline/run', async (req: Request, res: Response) => {
  const { articleName } = req.body as { articleName: string };
  if (!articleName?.trim()) {
    res.status(400).json({ error: 'articleName is required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function send(type: string, data: string, extra?: Record<string, unknown>) {
    const payload = JSON.stringify({ type, data, ts: new Date().toTimeString().slice(0, 8), ...extra });
    res.write(`data: ${payload}\n\n`);
  }

  const child = spawn('npx', ['tsx', 'run-pipeline.ts', articleName], {
    cwd: PIPELINE_DIR,
    env: { ...process.env },
    shell: false,
  });

  child.stdout.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) send('stdout', line);
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) send('stderr', line);
    }
  });

  child.on('close', (code: number | null) => {
    send('done', '', { exitCode: code ?? -1 });
    res.end();
  });

  child.on('error', (err: Error) => {
    send('error', err.message);
    res.end();
  });

  req.on('close', () => {
    child.kill();
  });
});

export default router;
