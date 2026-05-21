import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { fromSSO } from '@aws-sdk/credential-providers';
import OpenAI from 'openai';

export const MAX_RETRIES = 4;

let _openai: OpenAI | null = null;
function openaiClient(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'placeholder' });
  return _openai;
}

const bedrockClient = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-2',
  credentials: fromSSO({
    profile: process.env.AWS_PROFILE || 'tubi-core-dev-bedrock-user',
  }),
});

export async function callAI(system: string, user: string): Promise<string> {
  const command = new InvokeModelCommand({
    modelId: 'us.anthropic.claude-sonnet-4-6',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      system,
      messages: [{ role: 'user', content: user }],
      max_tokens: 8192,
      temperature: 0.7,
    }),
  });
  const response = await bedrockClient.send(command);
  const body = JSON.parse(new TextDecoder().decode(response.body));
  return body.content[0]?.text || '';
}

export async function runBrandCheck(
  serializedContent: string,
  brandVoiceReference: string,
  brandAlignmentPrompt: string,
): Promise<{ passed: boolean; overall: number; notes: string }> {
  const prompt = brandAlignmentPrompt
    .replace('{{brand_voice_reference}}', brandVoiceReference)
    .replace('{{generated_article}}', serializedContent);
  try {
    const response = await openaiClient().chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a Tubi brand reviewer. Return only valid JSON.' },
        { role: 'user', content: prompt },
      ],
    });
    const result = JSON.parse(response.choices[0]?.message?.content || '{}');
    const overall = (result.voice + result.specificity + result.angle + result.energy + result.consistency) / 5;
    return { passed: overall >= 3.5, overall, notes: result.notes || 'No notes' };
  } catch (err) {
    throw err;
  }
}

export async function selectContainersWithOpenAI(
  angle: string,
  containers: { id: string; title: string; subtitle: string; position: number }[],
): Promise<string[]> {
  const list = containers.map(c =>
    `pos:${c.position} id:${c.id} — ${c.title}${c.subtitle ? ` (${c.subtitle})` : ''}`
  ).join('\n');

  const prompt = `You are a Tubi blog editor choosing which Tubi content containers to pull titles from for a listicle article.

Article angle: "${angle}"

Below is the current list of Tubi containers, in the order they appear on Tubi's homepage today (position 1 = most featured/newest). Choose the 3 to 5 containers most likely to contain titles that fit the angle. Prefer lower position numbers (more current/featured) when relevance is similar.

Return valid JSON only: { "ids": ["id1", "id2", ...] }

Containers:
${list}`;

  const response = await openaiClient().chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'You are a Tubi blog editor. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ],
  });
  const result = JSON.parse(response.choices[0]?.message?.content || '{}');
  return result.ids || [];
}

export async function selectTitlesWithOpenAI(
  angle: string,
  candidatesList: string,
  promptTemplate: string,
): Promise<{ id: string; title: string; reason: string }[]> {
  const prompt = promptTemplate
    .replace('{{angle}}', angle)
    .replace('{{candidates}}', candidatesList);
  const response = await openaiClient().chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    temperature: 1.2,
    messages: [
      { role: 'system', content: 'You are a Tubi blog editor. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ],
  });
  const result = JSON.parse(response.choices[0]?.message?.content || '{}');
  return result.selected || [];
}

// Regenerate a single listicle blurb entry
export async function regenerateBlurb(entryTitle: string, contentTitle: string, contentType: string, articleTitle: string): Promise<string> {
  const system = `You write short, punchy blurbs for Tubi blog listicle entries. Tubi brand voice: direct, enthusiastic, champion the content. Never use: "delve", "meticulously", "showcases", "nuanced", em dashes. 80-120 words max per blurb.`;
  const user = `Write a fresh listicle blurb for this entry in the article "${articleTitle}":

Title: ${entryTitle}
Content: ${contentTitle} (${contentType})

Return ONLY the blurb text, no JSON, no labels, no extra text.`;

  const text = await callAI(system, user);
  return text.trim();
}
