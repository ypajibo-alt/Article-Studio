import { getToken } from './tubi.js';

const SEARCH_BASE  = 'https://search.production-public.tubi.io';
const TENSOR_BASE  = 'https://tensor.production-public.tubi.io';
const CONTENT_BASE = 'https://content-cdn.production-public.tubi.io';

export interface SearchResult {
  id: string;
  title: string;
  year: number | null;
  type: 'movie' | 'series';
  description: string;
  posterart?: string;
}

export interface FullMetadata {
  id: string;
  type: string;
  title: string;
  description: string;
  year: number;
  tags: string[];
  ratings: { system: string; rating: string }[];
  duration: number | null;
  directors: string[];
  cast: { name: string; characterName: string; role: string }[];
  posterart: string;
  landscape: string;
  videoPreviewUrl: string | null;
  hasTrailer: boolean;
  availability_starts: string | null;
  availability_ends: string | null;
}

async function authedFetch(url: string): Promise<Response> {
  const token = await getToken();
  return fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Accept-Language': 'en-US' } });
}

export async function searchTubi(q: string, limit = 20): Promise<SearchResult[]> {
  const token = await getToken();
  const res = await fetch(
    `${SEARCH_BASE}/api/v2/search?search=${encodeURIComponent(q)}&limit=${Math.min(limit * 2, 100)}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
  );
  if (!res.ok) return [];

  const data = await res.json() as Record<string, unknown>;
  const contents = data.contents as Record<string, Record<string, unknown>> ?? {};
  const qLower = q.toLowerCase();

  return Object.values(contents)
    .map(item => {
      const titleLower = String(item.title ?? '').toLowerCase();
      const descLower = String(item.description ?? '').toLowerCase();
      let score = titleLower === qLower ? 100
        : titleLower.startsWith(qLower) ? 80
        : titleLower.includes(qLower) ? 60
        : descLower.includes(qLower) ? 20
        : 0;
      return { item, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item }) => ({
      id: String(item.id),
      title: String(item.title ?? ''),
      year: (item.year as number) ?? null,
      type: (item.type === 's' ? 'series' : 'movie') as 'movie' | 'series',
      description: String(item.description ?? '').slice(0, 140),
      posterart: String((item.posterarts as string[])?.[0] ?? ''),
    }));
}

export async function fetchFullMetadata(contentId: string): Promise<FullMetadata | null> {
  const res = await authedFetch(`${CONTENT_BASE}/api/v2/contents?content_ids=${encodeURIComponent(contentId)}`);
  if (!res.ok) return null;

  const data = await res.json() as Record<string, Record<string, unknown> | null>;
  // API may zero-pad short IDs
  const meta = data[contentId] ?? data[`0${contentId}`] ?? Object.values(data).find(v => v !== null);
  if (!meta) return null;

  const gnCast = (meta.gn_fields as Record<string, unknown>)?.cast as Record<string, unknown>[] | null;
  const cast = gnCast?.length
    ? gnCast.map(c => ({ name: String(c.name ?? ''), characterName: String(c.character_name ?? ''), role: String(c.role ?? '') }))
    : (meta.actors as string[] ?? []).map(name => ({ name, characterName: '', role: 'Actor' }));

  return {
    id: contentId,
    type: String(meta.type ?? 'v'),
    title: String(meta.title ?? ''),
    description: String(meta.description ?? ''),
    year: (meta.year as number) ?? 0,
    tags: (meta.tags as string[]) ?? [],
    ratings: ((meta.ratings as Record<string, string>[]) ?? []).map(r => ({ system: String(r.system), rating: String(r.rating ?? r.value ?? r.code ?? '') })),
    duration: (meta.duration as number) ?? null,
    directors: (meta.directors as string[]) ?? [],
    cast,
    posterart: String((meta.posterarts as string[])?.[0] ?? ''),
    landscape: String((meta.landscape_images as string[])?.[0] ?? (meta.backgrounds as string[])?.[0] ?? ''),
    videoPreviewUrl: String(meta.video_preview_url ?? '') || null,
    hasTrailer: ((meta.trailers as unknown[]) ?? []).length > 0,
    availability_starts: (meta.availability_starts as string) ?? null,
    availability_ends: (meta.availability_ends as string) ?? null,
  };
}

export function formatCastList(cast: FullMetadata['cast']): string {
  return cast.map(c => c.characterName ? `- ${c.name} as ${c.characterName}` : `- ${c.name}`).join('\n');
}

// ─── Containers ──────────────────────────────────────────────────────────────

export interface ContainerListItem { id: string; title: string; slug: string; subtitle: string; }

export async function fetchAllContainers(): Promise<ContainerListItem[]> {
  const res = await authedFetch(`${TENSOR_BASE}/api/v1/browse_list?is_kids_mode=false`);
  if (!res.ok) return [];
  const data = await res.json() as Record<string, unknown>;
  const containers = (data.containers as Record<string, unknown>[]) ?? [];
  return containers.map(c => ({
    id: String(c.id),
    title: String(c.title ?? c.display_name ?? c.id),
    slug: String(c.slug ?? ''),
    subtitle: String(c.subtitle ?? ''),
  }));
}

export interface ContainerTitle {
  id: string; type: string; title: string; description: string;
  year: number; tags: string[];
  ratings: { system: string; rating: string }[];
  directors: string[];
  cast: { name: string; characterName: string; role: string }[];
}

export interface ContainerData {
  containerId: string; containerName: string; containerDescription: string;
  titles: ContainerTitle[];
}

export async function fetchContainerTitles(containerId: string, maxTitles = 200): Promise<ContainerData | null> {
  const firstRes = await authedFetch(
    `${TENSOR_BASE}/api/v7/containers/${encodeURIComponent(containerId)}?expanded=true&gn_fields=tms_id,ratings,cast,crew&limit=50`,
  );
  if (!firstRes.ok) return null;
  const firstData = await firstRes.json() as Record<string, unknown>;
  const container = firstData.container as Record<string, unknown>;

  const allContents: Record<string, Record<string, unknown>> = {};
  const merge = (contents: unknown) => {
    const items = Array.isArray(contents) ? contents : Object.values(contents as object ?? {});
    for (const item of items) {
      if (item?.id) allContents[item.id] = item;
    }
  };
  merge(firstData.contents);

  let cursor = (container?.cursor as string) ?? null;
  let pages = 1;
  while (cursor && Object.keys(allContents).length < maxTitles && pages < 20) {
    const res = await authedFetch(
      `${TENSOR_BASE}/api/v7/containers/${encodeURIComponent(containerId)}?expanded=true&gn_fields=tms_id,ratings,cast,crew&limit=50&cursor=${encodeURIComponent(cursor)}`,
    );
    if (!res.ok) break;
    let pageData: Record<string, unknown>;
    try { pageData = await res.json(); } catch { break; }
    const prev = Object.keys(allContents).length;
    merge(pageData.contents);
    if (Object.keys(allContents).length === prev) break;
    const newCursor = (pageData.container as Record<string, unknown>)?.cursor as string;
    if (!newCursor || newCursor <= cursor) break;
    cursor = newCursor;
    pages++;
  }

  const titles: ContainerTitle[] = Object.values(allContents).map((item) => ({
    id: String(item.id),
    type: String(item.type ?? 'v'),
    title: String(item.title ?? ''),
    description: String(item.description ?? ''),
    year: (item.year as number) ?? 0,
    tags: (item.tags as string[]) ?? [],
    ratings: ((item.ratings as Record<string, string>[]) ?? []).map(r => ({ system: String(r.system), rating: String(r.rating ?? r.value ?? r.code ?? '') })),
    directors: (item.directors as string[]) ?? [],
    cast: ((item as Record<string, unknown>).gn_fields as Record<string, unknown>)?.cast
      ? ((((item as Record<string, unknown>).gn_fields as Record<string, unknown>).cast) as Record<string, unknown>[]).map(c => ({ name: String(c.name ?? ''), characterName: String(c.character_name ?? ''), role: String(c.role ?? '') }))
      : ((item.actors as string[]) ?? []).map(name => ({ name, characterName: '', role: 'Actor' })),
  }));

  return {
    containerId: String(container.id),
    containerName: String(container.title ?? container.slug ?? containerId),
    containerDescription: String(container.description ?? ''),
    titles,
  };
}
