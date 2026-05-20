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
      max_tokens: 4096,
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
    return { passed: false, overall: 0, notes: `Brand check error: ${(err as Error).message}` };
  }
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
