import { canonicalizeModelId } from '../sources.js';

export const MAX_MODEL_TAGS = 20;
export const MAX_TAG_LENGTH = 32;
export const TAG_REQUEST_PREFIX = 'tag:';

export function normalizeTag(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, MAX_TAG_LENGTH);
}

export function normalizeTags(values) {
  const input = Array.isArray(values) ? values : String(values || '').split(/[\s,]+/);
  return [...new Set(input.map(normalizeTag).filter(Boolean))].slice(0, MAX_MODEL_TAGS);
}

export function getModelTagKey(modelId) {
  return canonicalizeModelId(modelId).base.toLowerCase();
}

export function getModelTags(config, modelId) {
  const key = getModelTagKey(modelId);
  return normalizeTags(config?.modelTags?.[key] || []);
}

export function setModelTags(config, modelId, tags) {
  if (!config.modelTags || typeof config.modelTags !== 'object' || Array.isArray(config.modelTags)) {
    config.modelTags = {};
  }
  const key = getModelTagKey(modelId);
  const normalized = normalizeTags(tags);
  if (normalized.length > 0) config.modelTags[key] = normalized;
  else delete config.modelTags[key];
  return { key, tags: normalized };
}

export function getConfiguredTagNames(config) {
  return [...new Set(Object.values(config?.modelTags || {}).flatMap(normalizeTags))].sort();
}
