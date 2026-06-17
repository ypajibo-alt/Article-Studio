import { MAX_HEADLINE_WORDS, MAX_LISTICLE_HEADLINE_WORDS } from './config.js';

const BANNED_WORDS = [
  'delve', 'meticulously', 'showcases', 'nuanced', 'multifaceted',
  'tapestry', 'realm', 'robust', 'leverage', 'facilitate', 'underscore',
  'landscape', 'compelling', 'indulge',
  'captivating', 'riveting', 'masterful', 'intriguing',
];
const BANNED_PHRASES = [
  'in conclusion', "it's worth noting", 'one can see', "whether you're",
  'elevates the material', 'elevates the medium', 'a journey through',
];
const NEGATIVE_BRAND_WORDS = ['stupid', 'bad', 'terrible', 'awful'];
const GENERIC_JARGON = ['binge-worthy', 'must-see', 'hidden gem'];

const EM_DASH_RE = /—/g;
const EXCLAMATION_RE = /!/g;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function isSentenceCase(headline: string): boolean {
  const words = headline.split(/\s+/).slice(1);
  const titleCaseCount = words.filter(w => w.length > 3 && /^[A-Z]/.test(w)).length;
  return titleCaseCount < Math.ceil(words.length * 0.5);
}

function applyAutoFixes(text: string): string {
  return text.replace(EM_DASH_RE, ',').replace(EXCLAMATION_RE, '.');
}

function parseAIJSON<T>(raw: string): T {
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/```\s*$/m, '').trim();
  try { return JSON.parse(cleaned); }
  catch {
    const match = cleaned.match(/\{[\s\S]+\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('AI returned unparseable output');
  }
}

export interface QualityResult<T> {
  passed: boolean;
  autoFixed: T;
  retryFeedback: string[];
}

// ─── Article ─────────────────────────────────────────────────────────────────

export interface ArticleCastEntry { name: string; bio: string; }
export interface ArticleOutput {
  headline: string;
  subheadline: string;
  introduction: string;
  cast: ArticleCastEntry[];
  pullQuote: string;
  whyWatchIt: string;
  moreDetails: { director: string; fullCast: string[]; streamingNote: string };
}

export function parseArticleJSON(raw: string): ArticleOutput {
  return parseAIJSON<ArticleOutput>(raw);
}

export function serializeArticleOutput(output: ArticleOutput): string {
  const castText = output.cast.map(c => `- ${c.name}: ${c.bio}`).join('\n');
  return [
    `Headline: ${output.headline}`,
    `Subheadline: ${output.subheadline}`,
    '',
    `Introduction:\n${output.introduction}`,
    '',
    `Cast:\n${castText}`,
    '',
    `Pull Quote: "${output.pullQuote}"`,
    '',
    `Why Watch It:\n${output.whyWatchIt}`,
  ].join('\n');
}

// ─── Listicle ────────────────────────────────────────────────────────────────

export interface ListicleEntry {
  contentId: string;
  title: string;
  year?: string | number;
  hook?: string;
  tease?: string;
  blurb: string;
}
export interface ListicleOutput {
  headline: string;
  subtitle: string;
  angle: string;
  angle_notes?: string;
  intro: string;
  entries: ListicleEntry[];
  closing: string;
}

export function parseListicleJSON(raw: string): ListicleOutput {
  return parseAIJSON<ListicleOutput>(raw);
}

export function serializeListicleOutput(output: ListicleOutput): string {
  const entries = output.entries.map(e => {
    const tease = e.tease ? ` — ${e.tease}` : '';
    return `- ${e.title}${tease}: ${e.blurb}`;
  }).join('\n');
  return [
    `Headline: ${output.headline}`,
    `Subtitle: ${output.subtitle}`,
    `Angle: ${output.angle}`,
    '',
    `Intro:\n${output.intro}`,
    '',
    `Entries:\n${entries}`,
    '',
    `Closing:\n${output.closing}`,
  ].join('\n');
}

export function runListicleQualityGate(output: ListicleOutput, validIds?: Set<string>): QualityResult<ListicleOutput> {
  const retryFeedback: string[] = [];
  const fixed: ListicleOutput = structuredClone(output);

  fixed.headline = fixed.headline || '';
  fixed.subtitle = fixed.subtitle || '';
  fixed.angle = fixed.angle || '';
  fixed.intro = fixed.intro || '';
  fixed.closing = fixed.closing || '';
  fixed.entries = (fixed.entries || []).map(e => ({
    contentId: e.contentId || '',
    title: e.title || '',
    year: e.year,
    hook: e.hook,
    tease: e.tease,
    blurb: e.blurb || '',
  }));

  fixed.intro = applyAutoFixes(fixed.intro);
  fixed.closing = applyAutoFixes(fixed.closing);
  fixed.entries.forEach(e => { e.blurb = applyAutoFixes(e.blurb); });

  if (wordCount(fixed.headline) > MAX_LISTICLE_HEADLINE_WORDS)
    retryFeedback.push(`Headline is ${wordCount(fixed.headline)} words, max ${MAX_LISTICLE_HEADLINE_WORDS}.`);

  const introPara = fixed.intro.split(/\n\n+/).filter(p => p.trim());
  if (introPara.length < 1)
    retryFeedback.push('Intro is missing.');
  else if (introPara.length > 4)
    retryFeedback.push(`Intro is too long (${introPara.length} paragraphs), max 3.`);

  if (fixed.entries.length < 8)
    retryFeedback.push(`Need at least 8 entries, got ${fixed.entries.length}.`);

  if (!fixed.closing || fixed.closing.trim().length < 5)
    retryFeedback.push('Missing closing section.');

  for (const entry of fixed.entries) {
    const wc = wordCount(entry.blurb);
    if (wc < 70 || wc > 120)
      retryFeedback.push(`Entry "${entry.title}" blurb is ${wc} words, need 70-120.`);
    if (!entry.contentId)
      retryFeedback.push(`Entry "${entry.title}" is missing contentId.`);
    else if (validIds && !validIds.has(entry.contentId))
      retryFeedback.push(`Entry "${entry.title}" has contentId "${entry.contentId}" which is not in the provided title list. Only use contentIds from the list you were given.`);
  }

  return { passed: retryFeedback.length === 0, autoFixed: fixed, retryFeedback };
}

export function runArticleQualityGate(output: ArticleOutput): QualityResult<ArticleOutput> {
  const retryFeedback: string[] = [];
  const fixed: ArticleOutput = structuredClone(output);

  fixed.headline = fixed.headline || '';
  fixed.subheadline = fixed.subheadline || '';
  fixed.introduction = fixed.introduction || '';
  fixed.cast = (fixed.cast || []).map(c => ({ name: c.name || '', bio: c.bio || '' }));
  fixed.pullQuote = fixed.pullQuote || '';
  fixed.whyWatchIt = fixed.whyWatchIt || '';
  fixed.moreDetails = fixed.moreDetails || { director: '', fullCast: [], streamingNote: 'Watch free on Tubi' };

  fixed.introduction = applyAutoFixes(fixed.introduction);
  fixed.whyWatchIt = applyAutoFixes(fixed.whyWatchIt);
  fixed.cast.forEach(c => { c.bio = applyAutoFixes(c.bio); });

  if (wordCount(fixed.headline) > MAX_HEADLINE_WORDS)
    retryFeedback.push(`Headline is ${wordCount(fixed.headline)} words, max ${MAX_HEADLINE_WORDS}.`);
  if (!isSentenceCase(fixed.headline))
    retryFeedback.push('Headline must be sentence case, not Title Case.');

  const intraPara = fixed.introduction.split(/\n\n+/).filter(p => p.trim());
  if (intraPara.length < 2 || intraPara.length > 3)
    retryFeedback.push(`Introduction needs 2-3 paragraphs, got ${intraPara.length}.`);

  if (fixed.cast.length < 1 || fixed.cast.length > 4)
    retryFeedback.push(`Cast needs 1-4 entries, got ${fixed.cast.length}.`);

  if (wordCount(fixed.pullQuote) > 20)
    retryFeedback.push(`Pull quote is ${wordCount(fixed.pullQuote)} words, max 20.`);

  const whyPara = fixed.whyWatchIt.split(/\n\n+/).filter(p => p.trim());
  if (whyPara.length < 2 || whyPara.length > 3)
    retryFeedback.push(`Why Watch It needs 2-3 paragraphs, got ${whyPara.length}.`);

  const allText = [fixed.headline, fixed.subheadline, fixed.introduction, ...fixed.cast.map(c => c.bio), fixed.pullQuote, fixed.whyWatchIt].join(' ').toLowerCase();

  const foundBanned = BANNED_WORDS.filter(w => allText.includes(w));
  if (foundBanned.length) retryFeedback.push(`Remove these words: ${foundBanned.join(', ')}`);

  const foundPhrases = BANNED_PHRASES.filter(p => allText.includes(p));
  if (foundPhrases.length) retryFeedback.push(`Remove these phrases: ${foundPhrases.join('; ')}`);

  const foundNegative = NEGATIVE_BRAND_WORDS.filter(w => allText.includes(w));
  if (foundNegative.length) retryFeedback.push(`Never disparage content. Remove: ${foundNegative.join(', ')}`);

  const foundJargon = GENERIC_JARGON.filter(j => allText.includes(j));
  if (foundJargon.length) retryFeedback.push(`Replace generic jargon: ${foundJargon.join(', ')}`);

  return { passed: retryFeedback.length === 0, autoFixed: fixed, retryFeedback };
}
