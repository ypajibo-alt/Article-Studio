// Programmatic quality checks + serializers for article output

const BANNED_WORDS = [
  'delve', 'meticulously', 'showcases', 'nuanced', 'multifaceted',
  'tapestry', 'realm', 'robust', 'leverage', 'facilitate', 'underscore',
  'elevate', 'landscape', 'journey', 'compelling', 'indulge',
  'captivating', 'riveting', 'masterful', 'intriguing',
];
const BANNED_PHRASES = ['in conclusion', "it's worth noting", 'one can see', "whether you're"];
const NEGATIVE_BRAND_WORDS = ['stupid', 'bad', 'terrible', 'awful'];
const GENERIC_JARGON = ['binge-worthy', 'must-see', 'hidden gem'];

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function isSentenceCase(headline: string): boolean {
  const words = headline.split(/\s+/).slice(1);
  const titleCaseCount = words.filter(w => w.length > 3 && /^[A-Z]/.test(w)).length;
  return titleCaseCount < Math.ceil(words.length * 0.5);
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
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/```\s*$/m, '').trim();
  try { return JSON.parse(cleaned); }
  catch {
    const match = cleaned.match(/\{[\s\S]+\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('AI returned unparseable output');
  }
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

export interface ListicleEntry { id: string; title: string; blurb: string; }
export interface ListicleOutput {
  headline: string;
  subheadline: string;
  introduction: string;
  entries: ListicleEntry[];
}

export function parseListicleJSON(raw: string): ListicleOutput {
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/```\s*$/m, '').trim();
  try { return JSON.parse(cleaned); }
  catch {
    const match = cleaned.match(/\{[\s\S]+\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('AI returned unparseable output');
  }
}

export function serializeListicleOutput(output: ListicleOutput): string {
  const entries = output.entries.map(e => `- ${e.title}: ${e.blurb}`).join('\n');
  return [
    `Headline: ${output.headline}`,
    `Subheadline: ${output.subheadline}`,
    '',
    `Introduction:\n${output.introduction}`,
    '',
    `Entries:\n${entries}`,
  ].join('\n');
}

export function runListicleQualityGate(output: ListicleOutput): QualityResult<ListicleOutput> {
  const retryFeedback: string[] = [];
  const fixed: ListicleOutput = structuredClone(output);

  fixed.headline = fixed.headline || '';
  fixed.subheadline = fixed.subheadline || '';
  fixed.introduction = fixed.introduction || '';
  fixed.entries = (fixed.entries || []).map(e => ({ id: e.id || '', title: e.title || '', blurb: e.blurb || '' }));

  // Auto-fix
  const emDash = /—/g;
  fixed.introduction = fixed.introduction.replace(emDash, ',').replace(/!/g, '.');
  fixed.entries.forEach(e => { e.blurb = e.blurb.replace(emDash, ',').replace(/!/g, '.'); });

  // Hard checks
  if (wordCount(fixed.headline) > 15)
    retryFeedback.push(`Headline is ${wordCount(fixed.headline)} words, max 15.`);
  if (!isSentenceCase(fixed.headline))
    retryFeedback.push('Headline must be sentence case, not Title Case.');

  const introPara = fixed.introduction.split(/\n\n+/).filter(p => p.trim());
  if (introPara.length < 2 || introPara.length > 3)
    retryFeedback.push(`Introduction needs 2-3 paragraphs, got ${introPara.length}.`);

  if (fixed.entries.length < 5)
    retryFeedback.push(`Need at least 5 entries, got ${fixed.entries.length}.`);

  for (const entry of fixed.entries) {
    const wc = wordCount(entry.blurb);
    if (wc < 60 || wc > 140)
      retryFeedback.push(`Entry "${entry.title}" blurb is ${wc} words, need 60-140.`);
  }

  const allText = [fixed.headline, fixed.subheadline, fixed.introduction, ...fixed.entries.map(e => e.blurb)].join(' ').toLowerCase();

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

  // Auto-fix
  const emDash = /—/g;
  fixed.introduction = fixed.introduction.replace(emDash, ',').replace(/!/g, '.');
  fixed.whyWatchIt = fixed.whyWatchIt.replace(emDash, ',').replace(/!/g, '.');
  fixed.cast.forEach(c => { c.bio = c.bio.replace(emDash, ',').replace(/!/g, '.'); });

  // Hard checks
  if (wordCount(fixed.headline) > 12)
    retryFeedback.push(`Headline is ${wordCount(fixed.headline)} words, max 12.`);
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
