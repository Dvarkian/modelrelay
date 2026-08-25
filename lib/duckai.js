/**
 * @file lib/duckai.js
 * @description Unofficial anonymous Duck.ai HTTP adapter.
 */

const DUCKAI_ORIGIN = 'https://duck.ai';
const STATUS_PATH = '/duckchat/v1/status';
const DUCKAI_MODELS = [
  ['gpt-5.4-nano', 'GPT-5.4 Nano'],
  ['gpt-5.4-mini', 'GPT-5.4 Mini'],
  ['claude-haiku-4-5', 'Claude Haiku 4.5'],
  ['mistral-small', 'Mistral Small 4'],
  ['tinfoil/gpt-oss-120b', 'GPT OSS 120B'],
  ['gemma-4-31b', 'Gemma 4 31B'],
];
const CHAT_PATH = '/duckchat/v1/chat';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MODEL = 'gpt-4o-mini';
const USER_AGENT = 'Mozilla/5.0 (compatible; modelrelay Duck.ai adapter)';

function asText(value) { return typeof value === 'string' ? value.trim() : ''; }
function parseJsonSafely(text) { try { return text ? JSON.parse(text) : null; } catch { return null; } }
function getHeader(headers, name) { return typeof headers?.get === 'function' ? headers.get(name) : null; }
function collectSetCookies(headers) {
  if (typeof headers?.getSetCookie === 'function') return headers.getSetCookie().map(String).filter(Boolean);
  const value = getHeader(headers, 'set-cookie');
  return value ? [value] : [];
}

export function mergeDuckAiCookies(previous, headers) {
  const jar = new Map();
  for (const cookie of String(previous || '').split(';')) {
    const idx = cookie.indexOf('=');
    if (idx > 0) jar.set(cookie.slice(0, idx).trim(), cookie.slice(idx + 1).trim());
  }
  for (const raw of collectSetCookies(headers)) {
    const pair = String(raw).split(';', 1)[0].trim();
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  return [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
}

export function redactDuckAiSecret(value) {
  return String(value || '')
    .replace(/(x-vqd-4\s*[:=]\s*)[^,;\s]+/ig, '$1[redacted]')
    .replace(/(cookie\s*[:=]\s*)[^\n]+/ig, '$1[redacted]')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/ig, '$1[redacted]');
}

export function extractDuckAiVqd(headers, body = '') {
  const headerValue = getHeader(headers, 'x-vqd-4') || getHeader(headers, 'x-vqd');
  if (headerValue) return String(headerValue).trim();
  const parsed = parseJsonSafely(body);
  return asText(parsed?.vqd || parsed?.vqd4 || parsed?.['x-vqd-4']) || null;
}

export function classifyDuckAiError(status, body = '') {
  const text = String(body || '').toLowerCase();
  if ([401, 403].includes(Number(status))) return 'session';
  if (Number(status) === 418 || text.includes('rate limit') || text.includes('usage limit') || text.includes('quota')) return 'rate-limit';
  if (Number(status) === 404 || text.includes('model not found')) return 'model';
  return 'network';
}

export function extractDuckAiModels(payload) {
  const records = Array.isArray(payload) ? payload : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.data) ? payload.data : [];
  const seen = new Set();
  return records.flatMap(record => {
    const modelId = typeof record === 'string' ? record.trim() : asText(record?.id || record?.model || record?.integration_id || record?.slug || record?.name);
    if (!modelId || seen.has(modelId)) return [];
    seen.add(modelId);
    return [{ modelId, label: typeof record === 'object' && record ? asText(record.name || record.display_name || record.title) || modelId : modelId }];
  });
}

export function buildDuckAiMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map(message => ({
    role: message?.role || 'user',
    content: typeof message?.content === 'string' ? message.content : Array.isArray(message?.content)
      ? message.content.filter(part => part?.type === 'text' || part?.type === 'input_text').map(part => part.text || '').join('\n')
      : String(message?.content || ''),
  }));
}

export function buildDuckAiRequest(body, sessionId) {
  const messages = buildDuckAiMessages(body?.messages);
  const lastUser = [...messages].reverse().find(message => message.role === 'user');
  return {
    model: asText(body?.model) || DEFAULT_MODEL,
    message: lastUser?.content || '',
    history: messages.slice(0, Math.max(0, messages.length - (lastUser ? 1 : 0))),
    session_id: sessionId,
  };
}

function extractTextFromObject(value) {
  if (!value || typeof value !== 'object') return '';
  const content = value.message || value.response || value.text || value.content || value.chunk;
  if (typeof content === 'string') return asText(content);
  if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : part?.text || '').join('').trim();
  return asText(value?.choices?.[0]?.message?.content) || asText(value?.choices?.[0]?.text);
}

export function parseDuckAiResponse(body) {
  const parsed = parseJsonSafely(body);
  if (!parsed) return { text: String(body || '').trim(), model: null, sessionId: null, done: true };
  return { text: extractTextFromObject(parsed), model: asText(parsed.model) || null, sessionId: asText(parsed.session_id || parsed.sessionId) || null, done: parsed.done === true };
}

export function parseDuckAiStreamChunk(chunk) {
  const output = [];
  for (const line of String(chunk || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === '[DONE]') { output.push({ text: '', done: true }); continue; }
    const parsed = parseJsonSafely(raw);
    if (parsed) output.push({ text: extractTextFromObject(parsed), model: asText(parsed.model) || null, sessionId: asText(parsed.session_id || parsed.sessionId) || null, done: parsed.done === true });
  }
  return output;
}

function timeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, clear: () => clearTimeout(timer) };
}

export class DuckAiClient {
  constructor({ fetchImpl = globalThis.fetch, origin = DUCKAI_ORIGIN, timeoutMs = DEFAULT_TIMEOUT_MS, sessionId = null } = {}) {
    this.fetch = fetchImpl;
    this.origin = origin.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.sessionId = sessionId || `modelrelay-${Math.random().toString(36).slice(2)}`;
    this.cookies = '';
    this.vqd = null;
    this.models = [];
    this.bootstrapPromise = null;
  }

  resetSession() { this.cookies = ''; this.vqd = null; this.bootstrapPromise = null; }

  async bootstrap() {
    if (this.bootstrapPromise) return this.bootstrapPromise;
    this.bootstrapPromise = (async () => {
      const { controller, clear } = timeoutSignal(this.timeoutMs);
      try {
        const response = await this.fetch(`${this.origin}${STATUS_PATH}`, { method: 'GET', headers: { Accept: '*/*', 'x-vqd-accept': '1', 'User-Agent': USER_AGENT, ...(this.cookies ? { Cookie: this.cookies } : {}) }, signal: controller.signal });
        const body = await response.text();
        this.cookies = mergeDuckAiCookies(this.cookies, response.headers);
        this.vqd = extractDuckAiVqd(response.headers, body) || this.vqd;
        this.vqd = this.vqd || response.headers?.get?.('x-vqd-hash-1') || null;
        if (!response.ok) throw new Error(`Duck.ai session bootstrap failed (HTTP ${response.status}).`);
        return { ok: true, status: response.status, body };
      } finally { clear(); this.bootstrapPromise = null; }
    })();
    return this.bootstrapPromise;
  }

  async discoverModels() {
    const bootstrap = await this.bootstrap();
    this.models = extractDuckAiModels(parseJsonSafely(bootstrap.body));
    if (this.models.length === 0) {
      this.models = DUCKAI_MODELS.map(([modelId, label]) => ({ modelId, label }));
    }
    return this.models;
  }

  async chat(body, { stream = false, retrySession = true } = {}) {
    await this.bootstrap();
    const request = buildDuckAiRequest(body, this.sessionId);
    if (!request.message.trim()) throw new Error('Duck.ai request requires a non-empty user message.');
    const { controller, clear } = timeoutSignal(this.timeoutMs);
    try {
      const response = await this.fetch(`${this.origin}${CHAT_PATH}`, {
        method: 'POST',
        headers: { Accept: stream ? 'text/event-stream' : 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, ...(this.cookies ? { Cookie: this.cookies } : {}), ...(this.vqd ? { 'x-vqd-4': this.vqd } : {}) },
        body: JSON.stringify(request), signal: controller.signal,
      });
      const text = await response.text();
      this.cookies = mergeDuckAiCookies(this.cookies, response.headers);
      this.vqd = extractDuckAiVqd(response.headers, text) || this.vqd;
      if (!response.ok && retrySession && [401, 403, 418].includes(response.status)) { this.resetSession(); return this.chat(body, { stream, retrySession: false }); }
      return { response, text, category: response.ok ? null : classifyDuckAiError(response.status, text) };
    } finally { clear(); }
  }
}

export const DUCKAI_DEFAULT_MODEL = DEFAULT_MODEL;
export const DUCKAI_ORIGIN_URL = DUCKAI_ORIGIN;
