import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(__dirname, '..', 'prompts');
const VERSIONS_DIR = path.join(PROMPTS_DIR, 'versions');

const PROMPT_FILES = [
  { key: 'article-system',       file: 'article-system-prompt.md',       label: 'Single Title — System Prompt',    description: 'Core persona and format rules sent to Claude for every single-title article.' },
  { key: 'article-user',         file: 'article-user-prompt.md',         label: 'Single Title — User Prompt',      description: 'Per-generation template filled with title metadata (cast, tags, description).' },
  { key: 'coming-soon-system',   file: 'coming-soon-system-prompt.md',   label: 'Coming Soon — System Prompt',     description: 'Voice and format rules for coming soon articles about titles not yet on Tubi.' },
  { key: 'coming-soon-user',     file: 'coming-soon-user-prompt.md',     label: 'Coming Soon — User Prompt',       description: 'Per-generation template filled with title metadata and release date.' },
  { key: 'listicle-system',      file: 'listicle-system-prompt.md',      label: 'Listicle — System Prompt',        description: 'Voice, entry structure, and angle rules for all listicle generation.' },
  { key: 'listicle-user',        file: 'listicle-user-prompt.md',        label: 'Listicle — User Prompt',          description: 'Per-generation template filled with container name, description, and title list.' },
  { key: 'brand-voice',          file: 'brand-voice-reference.md',       label: 'Brand Voice Reference',           description: 'Reference document used by GPT-4o during the brand alignment check.' },
  { key: 'brand-alignment',      file: 'brand-alignment-prompt.md',      label: 'Brand Alignment Prompt',          description: 'Scoring prompt sent to GPT-4o to evaluate each generated article against brand guidelines.' },
];

function ensureVersionsDir() {
  if (!fs.existsSync(VERSIONS_DIR)) fs.mkdirSync(VERSIONS_DIR, { recursive: true });
}

function listVersions(file: string): { timestamp: string; label: string }[] {
  ensureVersionsDir();
  const base = path.basename(file, '.md');
  return fs.readdirSync(VERSIONS_DIR)
    .filter(f => f.startsWith(base + '.') && f.endsWith('.md'))
    .sort()
    .reverse()
    .map(f => {
      const ts = f.replace(base + '.', '').replace('.md', '');
      return { timestamp: ts, label: ts.replace('T', ' ').replace(/-/g, ':').slice(0, 16) };
    });
}

// GET /api/settings/prompts — all prompts with content + version list
router.get('/settings/prompts', (_req: Request, res: Response) => {
  try {
    const prompts = PROMPT_FILES.map(p => {
      const filePath = path.join(PROMPTS_DIR, p.file);
      const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
      return {
        key: p.key,
        file: p.file,
        label: p.label,
        description: p.description,
        content,
        versions: listVersions(p.file),
      };
    });
    res.json({ prompts });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/settings/prompts/:key/version/:timestamp — load a specific version
router.get('/settings/prompts/:key/version/:timestamp', (req: Request, res: Response) => {
  const p = PROMPT_FILES.find(p => p.key === req.params.key);
  if (!p) { res.status(404).json({ error: 'Prompt not found' }); return; }
  const base = path.basename(p.file, '.md');
  const versionFile = path.join(VERSIONS_DIR, `${base}.${req.params.timestamp}.md`);
  if (!fs.existsSync(versionFile)) { res.status(404).json({ error: 'Version not found' }); return; }
  res.json({ content: fs.readFileSync(versionFile, 'utf-8') });
});

// PUT /api/settings/prompts/:key — save edited prompt, snapshot current as version
router.put('/settings/prompts/:key', (req: Request, res: Response) => {
  const p = PROMPT_FILES.find(p => p.key === req.params.key);
  if (!p) { res.status(404).json({ error: 'Prompt not found' }); return; }
  const { content } = req.body as { content: string };
  if (typeof content !== 'string') { res.status(400).json({ error: 'content required' }); return; }

  const filePath = path.join(PROMPTS_DIR, p.file);
  ensureVersionsDir();

  // Snapshot current version before overwriting
  if (fs.existsSync(filePath)) {
    const current = fs.readFileSync(filePath, 'utf-8');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = path.basename(p.file, '.md');
    fs.writeFileSync(path.join(VERSIONS_DIR, `${base}.${ts}.md`), current);
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  res.json({ ok: true, versions: listVersions(p.file) });
});

// POST /api/settings/prompts/:key/restore/:timestamp — restore a version as current
router.post('/settings/prompts/:key/restore/:timestamp', (req: Request, res: Response) => {
  const p = PROMPT_FILES.find(p => p.key === req.params.key);
  if (!p) { res.status(404).json({ error: 'Prompt not found' }); return; }
  const base = path.basename(p.file, '.md');
  const versionFile = path.join(VERSIONS_DIR, `${base}.${req.params.timestamp}.md`);
  if (!fs.existsSync(versionFile)) { res.status(404).json({ error: 'Version not found' }); return; }

  const filePath = path.join(PROMPTS_DIR, p.file);
  ensureVersionsDir();

  // Snapshot current before restoring
  if (fs.existsSync(filePath)) {
    const current = fs.readFileSync(filePath, 'utf-8');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(path.join(VERSIONS_DIR, `${base}.${ts}.md`), current);
  }

  fs.writeFileSync(filePath, fs.readFileSync(versionFile, 'utf-8'), 'utf-8');
  res.json({ ok: true, versions: listVersions(p.file) });
});

export default router;
