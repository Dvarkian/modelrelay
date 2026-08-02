import { canonicalizeModelId, resolveAliasedModelId } from '../sources.js';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const MODEL_QUALITY_CACHE_MS = 24 * 60 * 60_000;
export const DEFAULT_MODEL_QUALITY = 0.45;

let cachedQuality = null;
let cachedAt = 0;

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function qualityLookupKeys(modelId) {
  const resolved = resolveAliasedModelId(String(modelId || '').trim().toLowerCase());
  if (!resolved) return [];
  const { base, unprefixed } = canonicalizeModelId(resolved);
  const normalizedBase = base.replace(/^~/, '').replace(/-free$/i, '');
  const normalizedLeaf = unprefixed.replace(/-free$/i, '');
  return [...new Set([
    normalizedBase,
    normalizedLeaf,
    normalizedBase.replace(/:/g, '-'),
    normalizedLeaf.replace(/:/g, '-'),
  ].filter(Boolean))];
}

export function getArtificialAnalysisCodingIndex(model) {
  const value = Number(model?.benchmarks?.artificial_analysis?.coding_index);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function getDesignArenaCodeElo(model) {
  const rows = model?.benchmarks?.design_arena;
  if (!Array.isArray(rows)) return null;
  const match = rows.find(row => row?.arena === 'models' && row?.category === 'codecategories');
  const value = Number(match?.elo);
  return Number.isFinite(value) ? value : null;
}

export function fitLinearRegression(points) {
  const valid = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (valid.length < 2) return null;
  const meanX = valid.reduce((sum, [x]) => sum + x, 0) / valid.length;
  const meanY = valid.reduce((sum, [, y]) => sum + y, 0) / valid.length;
  const denominator = valid.reduce((sum, [x]) => sum + ((x - meanX) ** 2), 0);
  if (denominator === 0) return null;
  const slope = valid.reduce((sum, [x, y]) => sum + ((x - meanX) * (y - meanY)), 0) / denominator;
  return { slope, intercept: meanY - (slope * meanX), sampleSize: valid.length };
}

function metadataQuality(model, popularityRank, catalogSize, nowMs) {
  const popularity = popularityRank == null || catalogSize < 2
    ? 0.5
    : 1 - ((popularityRank - 1) / (catalogSize - 1));
  const createdMs = Number(model?.created) * 1000;
  const ageDays = Number.isFinite(createdMs) ? Math.max(0, (nowMs - createdMs) / 86_400_000) : 365;
  const recency = clamp(1 - (ageDays / 730));
  const parameters = new Set(Array.isArray(model?.supported_parameters) ? model.supported_parameters : []);
  const features = [
    parameters.has('reasoning') || parameters.has('include_reasoning'),
    parameters.has('tools') || parameters.has('tool_choice'),
    parameters.has('structured_outputs') || parameters.has('response_format'),
  ].filter(Boolean).length / 3;
  const context = Number(model?.context_length);
  const contextScore = Number.isFinite(context) && context > 0
    ? clamp(Math.log2(context / 32768) / 5)
    : 0;
  return clamp(0.35 + (0.15 * popularity) + (0.05 * recency) + (0.05 * features) + (0.05 * contextScore));
}

function modelKeys(model) {
  const ids = [model?.id, model?.canonical_slug, model?.alias_target?.slug];
  return [...new Set(ids.flatMap(qualityLookupKeys))];
}

export function buildOpenRouterQualityIndex(catalog, popularityCatalog = catalog, nowMs = Date.now()) {
  const models = Array.isArray(catalog) ? catalog : [];
  const popular = Array.isArray(popularityCatalog) ? popularityCatalog : [];
  const popularityRanks = new Map();
  popular.forEach((model, index) => {
    for (const key of modelKeys(model)) {
      if (!popularityRanks.has(key)) popularityRanks.set(key, index + 1);
    }
  });

  const regression = fitLinearRegression(models.flatMap(model => {
    const elo = getDesignArenaCodeElo(model);
    const coding = getArtificialAnalysisCodingIndex(model);
    return elo == null || coding == null ? [] : [[elo, coding]];
  }));
  const index = new Map();

  for (const model of models) {
    const keys = modelKeys(model);
    if (keys.length === 0) continue;
    const coding = getArtificialAnalysisCodingIndex(model);
    const elo = getDesignArenaCodeElo(model);
    const rank = keys.map(key => popularityRanks.get(key)).find(value => value != null) ?? null;
    let entry;
    if (coding != null) {
      entry = { score: clamp(coding / 100), source: 'artificial-analysis', isEstimated: false, detail: `coding index ${coding}` };
    } else if (elo != null && regression) {
      const predicted = clamp(regression.intercept + (regression.slope * elo), 20, 90);
      entry = {
        score: predicted / 100,
        source: 'design-arena',
        isEstimated: true,
        detail: `code Elo ${elo}; regression n=${regression.sampleSize}`,
      };
    } else {
      entry = {
        score: metadataQuality(model, rank, popular.length || models.length, nowMs),
        source: 'metadata',
        isEstimated: true,
        detail: rank == null ? 'capability/recency/context heuristic' : `popularity rank ${rank}/${popular.length}`,
      };
    }
    entry = { ...entry, modelId: model.id };
    for (const key of keys) {
      const current = index.get(key);
      const priority = { 'artificial-analysis': 3, 'design-arena': 2, metadata: 1 };
      if (!current || priority[entry.source] > priority[current.source]) index.set(key, entry);
    }
  }
  return { index, regression, catalogSize: models.length };
}

export function resolveModelQuality(qualityData, modelId, localScore = null) {
  for (const key of qualityLookupKeys(modelId)) {
    const match = qualityData?.index?.get(key);
    if (match) return match;
  }
  const normalized = Number(localScore);
  if (Number.isFinite(normalized) && normalized > 0) {
    return { score: normalized > 1 ? normalized / 100 : normalized, source: 'local-fallback', isEstimated: true, detail: 'scores.js offline fallback' };
  }
  return { score: DEFAULT_MODEL_QUALITY, source: 'default-fallback', isEstimated: true, detail: 'no catalog or local score' };
}

async function fetchCatalog(fetchImpl, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response;
  try {
    response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`OpenRouter model catalog returned HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload?.data)) throw new Error('OpenRouter model catalog returned an invalid payload');
  return payload.data;
}

export async function fetchOpenRouterQualityIndex({ fetchImpl = fetch, nowMs = Date.now(), force = false } = {}) {
  if (!force && cachedQuality && (nowMs - cachedAt) < MODEL_QUALITY_CACHE_MS) return cachedQuality;
  const [catalog, popularity] = await Promise.all([
    fetchCatalog(fetchImpl, OPENROUTER_MODELS_URL),
    fetchCatalog(fetchImpl, `${OPENROUTER_MODELS_URL}?sort=most-popular`),
  ]);
  cachedQuality = buildOpenRouterQualityIndex(catalog, popularity, nowMs);
  cachedAt = nowMs;
  return cachedQuality;
}
