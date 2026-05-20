import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const PROMPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

export async function loadPrompt(filename: string): Promise<string> {
  return fs.readFile(path.join(PROMPTS_DIR, filename), 'utf-8');
}

export function fillTemplate(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, value),
    template,
  );
}
