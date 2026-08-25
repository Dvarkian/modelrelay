/**
 * @file lib/duckai.js
 * @description Unofficial anonymous Duck.ai HTTP adapter.
 */

import vm from 'node:vm';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';

const DUCKAI_ORIGIN = 'https://duck.ai';
const STATUS_PATH = '/duckchat/v1/status';
const CHAT_PATH = '/duckchat/v1/chat';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MODEL = 'gpt-5.4-mini';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
// Fallbacks used only if the live frontend metadata probe fails. Duck.ai redeploys
// frequently and validates both values against the current bundle, so we normally
// derive them at bootstrap time via resolveDuckAiFrontendMeta() below.
const FALLBACK_VQD_STACK = 'Error\nat l (https://duck.ai/dist/duckai-dist/entry.duckai.4e497f0b89b579031f9b.js:2:1823277)';
const FALLBACK_FE_VERSION = 'serp_20260824_091140_ET-6683fc519f227409aa7385b624cf51c902e320a9';
// Duck.ai's status endpoint exposes service flags, not the model catalog, so the
// provider is always registered with these currently available models.
const DUCKAI_MODELS = [
  ['gpt-5.6-luna', 'GPT-5.6 Luna'],
  ['gpt-5.4-mini', 'GPT-5.4 Mini'],
  ['claude-opus-4-8', 'Claude Opus 4.8'],
  ['claude-sonnet-4-6', 'Claude Sonnet 4.6'],
  ['claude-haiku-4-5', 'Claude Haiku 4.5'],
  ['mistral-small-2603', 'Mistral Small 4'],
  ['tinfoil/gpt-oss-120b', 'GPT OSS 120B'],
  ['tinfoil/gemma4-31b', 'Gemma 4 31B'],
];

function asText(value) { return typeof value === 'string' ? value.trim() : ''; }
function parseJsonSafely(text) { try { return text ? JSON.parse(text) : null; } catch { return null; } }
function getHeader(headers, name) { return typeof headers?.get === 'function' ? headers.get(name) : null; }
function collectSetCookies(headers) {
  if (typeof headers?.getSetCookie === 'function') return headers.getSetCookie().map(String).filter(Boolean);
  const value = getHeader(headers, 'set-cookie');
  return value ? [value] : [];
}
export function toBase64(text) { return Buffer.from(text, 'utf8').toString('base64'); }
function fromBase64(text) { return Buffer.from(text, 'base64').toString('utf8'); }
function sha256Base64(value) { return createHash('sha256').update(String(value)).digest('base64'); }

// The x-vqd-hash-1 challenge result must carry meta.stack and the request an
// x-fe-version that match duck.ai's *current* frontend bundle; stale values get
// rejected with 418 ERR_CHALLENGE. This probes the live page + entry script to
// derive both. Cached module-wide so a 2MB bundle fetch happens rarely.
let frontendMetaCache = null;
const FRONTEND_META_TTL_MS = 10 * 60_000;

export async function resolveDuckAiFrontendMeta(fetchImpl = globalThis.fetch) {
  const cached = frontendMetaCache;
  if (cached && Date.now() - cached.resolvedAt < FRONTEND_META_TTL_MS) return cached.meta;

  const html = await (await fetchImpl(`${DUCKAI_ORIGIN}/`, { headers: { accept: 'text/html,*/*', 'user-agent': USER_AGENT } })).text();
  const versionTag = html.match(/data-version-tag="([^"]+)"/)?.[1] || '';
  const versionSha = html.match(/data-version-sha="([^"]+)"/)?.[1] || '';
  const entryScript = html.match(/((?:[\w.-]+\.)?entry\.duckai\.[\w-]+\.js)/)?.[1] || '';
  if (!versionTag || !versionSha || !entryScript) throw new Error('Duck.ai frontend metadata not found on landing page.');

  const entryUrl = `${DUCKAI_ORIGIN}/dist/duckai-dist/${entryScript}`;
  const js = await (await fetchImpl(entryUrl, { headers: { accept: '*/*', 'user-agent': USER_AGENT } })).text();
  // Mirror how the live bundle builds meta.stack: d(new Error) reports the first
  // frame of an Error created right where `stack:<fn>(new Error)` appears.
  const site = js.match(/stack:\s*[A-Za-z_$][\w$]*\(new Error\)/);
  if (!site) throw new Error('Duck.ai entry script does not contain the expected vqd stack call.');
  const errorIndex = site.index + site[0].indexOf('new Error');
  const line = [...js.slice(0, errorIndex)].reduce((acc, ch) => acc + (ch === '\n' ? 1 : 0), 0) + 1;
  const lastNewline = js.lastIndexOf('\n', errorIndex - 1);
  const column = errorIndex - lastNewline;
  let frameName = 'l';
  for (const fn of js.slice(0, site.index).matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) frameName = fn[1];

  const meta = { feVersion: `${versionTag}-${versionSha}`, vqdStack: `Error\nat ${frameName} (${entryUrl}:${line}:${column})` };
  frontendMetaCache = { meta, resolvedAt: Date.now() };
  return meta;
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

// Browser-only headers Chrome always sends on same-origin XHR; their absence is
// a classic bot signal and likely contributes to aggressive throttling.
const BROWSER_HINT_HEADERS = {
  'sec-ch-ua': '"Chromium";v="149", "Not?A_Brand";v="24", "Google Chrome";v="149"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'accept-language': 'en-US,en;q=0.9',
};

export function classifyDuckAiError(status, body = '') {
  const text = String(body || '').toLowerCase();
  if ([401, 403].includes(Number(status))) return 'session';
  if ([418, 429].includes(Number(status)) || text.includes('rate limit') || text.includes('usage limit') || text.includes('quota')) return 'rate-limit';
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

function buildDuckAiPublicKey() {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  return { alg: 'RSA-OAEP-256', e: jwk.e, ext: true, key_ops: ['encrypt'], kty: 'RSA', n: jwk.n, use: 'enc' };
}

function buildFeSignals() {
  return toBase64(JSON.stringify({ start: 1, events: [{ name: 'startNewChat_free', delta: 1 }], end: 1 }));
}

export function buildDuckAiRequest(body, sessionId) {
  const messages = buildDuckAiMessages(body?.messages)
    .map(message => message.role === 'system' ? { ...message, role: 'user' } : message);
  const conversationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(sessionId || ''))
    ? sessionId
    : randomUUID();
  return {
    model: asText(body?.model) || DEFAULT_MODEL,
    messages,
    metadata: { toolChoice: { NewsSearch: false, VideosSearch: false, LocalSearch: false, WeatherForecast: false } },
    canUseTools: true,
    reasoningEffort: 'none',
    canUseApproxLocation: null,
    canDelegateImageGeneration: null,
    durableStream: {
      messageId: randomUUID(),
      conversationId,
      publicKey: buildDuckAiPublicKey(),
    },
  };
}

function extractTextFromObject(value, { trim = true } = {}) {
  if (!value || typeof value !== 'object') return '';
  const content = value.message || value.response || value.text || value.content || value.chunk;
  // Never trim when reassembling streamed deltas: Duck.ai puts inter-token
  // whitespace inside individual chunks, and trimming would glue words together.
  if (!trim) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : part?.text || '').join('');
    return (typeof value?.choices?.[0]?.message?.content === 'string' ? value.choices[0].message.content : '')
      || (typeof value?.choices?.[0]?.text === 'string' ? value.choices[0].text : '');
  }
  if (typeof content === 'string') return asText(content);
  if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : part?.text || '').join('').trim();
  return asText(value?.choices?.[0]?.message?.content) || asText(value?.choices?.[0]?.text);
}

export function parseDuckAiResponse(body) {
  const streamChunks = parseDuckAiStreamChunk(body);
  const streamText = streamChunks.map(chunk => chunk.text).join('');
  if (streamText) {
    const model = streamChunks.find(chunk => chunk.model)?.model || null;
    return { text: streamText, model, sessionId: null, done: true };
  }
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
    if (parsed) output.push({ text: extractTextFromObject(parsed, { trim: false }), model: asText(parsed.model) || null, sessionId: asText(parsed.session_id || parsed.sessionId) || null, done: parsed.done === true });
  }
  return output;
}

// Translates Duck.ai's native SSE stream into an OpenAI chat.completions response
// so routed requests and the dashboard see a standard shape.
export async function transformDuckAiResponse(response, modelId, stream = false) {
  if (!response?.ok) return response;
  const chunks = parseDuckAiStreamChunk(await response.text());
  const fullText = chunks.map(chunk => chunk.text).join('');
  const created = Math.floor(Date.now() / 1000);
  const responseId = `chatcmpl-${Date.now()}`;

  if (stream) {
    let body = '';
    let index = 0;
    for (const chunk of chunks) {
      if (!chunk.text) continue;
      body += `data: ${JSON.stringify({
        id: responseId,
        object: 'chat.completion.chunk',
        created,
        model: modelId,
        choices: [{ index: 0, delta: index === 0 ? { role: 'assistant', content: chunk.text } : { content: chunk.text }, finish_reason: null }],
      })}\n\n`;
      index += 1;
    }
    body += `data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created, model: modelId, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`;
    body += 'data: [DONE]\n\n';
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  const json = JSON.stringify({
    id: responseId,
    object: 'chat.completion',
    created,
    model: modelId,
    choices: [{ index: 0, message: { role: 'assistant', content: fullText }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
  return new Response(json, { status: 200, headers: { 'content-type': 'application/json' } });
}

// Duck.ai serves an obfuscated JS challenge (x-vqd-hash-1) that must be executed
// in a browser-like sandbox to derive the token used for chat requests. This is
// the same mechanism the duck2api project implements.
const VQD_BROWSER_PRELUDE = `(function () {
"use strict";
var userAgent__ = __goUserAgent;
function TextEncoder__() {}
TextEncoder__.prototype.encode = function (value) {
  var text = String(value);
  var encoded = encodeURIComponent(text);
  var bytes = [];
  for (var i = 0; i < encoded.length; i++) {
    if (encoded[i] === "%") { bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(encoded.charCodeAt(i));
  }
  return new Uint8Array(bytes);
};
var navigator__ = {
  userAgent: userAgent__, platform: "Win32", language: "en-US",
  languages: ["en-US", "en"], cookieEnabled: true, onLine: true,
  hardwareConcurrency: 4, maxTouchPoints: 0, vendor: "Google Inc.",
  vendorSub: "", productSub: "20030107", appCodeName: "Mozilla",
  appName: "Netscape", appVersion: userAgent__, product: "Gecko",
  doNotTrack: null, webdriver: false, deviceMemory: 8,
  javaEnabled: function () { return false; },
  getBattery: function () { return Promise.resolve({ level: 1, charging: true }); },
};
function NodeList__(items) {
  var vals = items || [];
  for (var i = 0; i < vals.length; i++) this[i] = vals[i];
  this.length = vals.length;
}
NodeList__.prototype.item = function (i) { return this[i] || null; };
NodeList__.prototype.forEach = function (fn) { for (var i = 0; i < this.length; i++) fn(this[i], i, this); };
function Element__(tagName) {
  var name = String(tagName || "").toUpperCase();
  this.tagName = name; this.nodeType = 1; this.nodeName = name;
  this.children = []; this.parentNode = null; this.ownerDocument = null;
  this.attributes = {}; this.innerHTML = ""; this.textContent = "";
  this.srcdoc = ""; this.src = "";
  this.style = { cssText: "", display: "inline-block",
    getPropertyValue: function (n) { return String(n).toLowerCase() === "display" ? this.display || "inline-block" : ""; } };
  this.offsetWidth = 1; this.offsetHeight = 1; this.scrollHeight = 1;
  this.clientWidth = 1; this.clientHeight = 1;
}
Element__.prototype.constructor = Element__;
Element__.prototype.appendChild = function (child) { child.parentNode = this; child.ownerDocument = this.ownerDocument; this.children.push(child); return child; };
Element__.prototype.removeChild = function (child) { var idx = this.children.indexOf(child); if (idx >= 0) { this.children.splice(idx, 1); child.parentNode = null; } return child; };
function matchesAttributeSelector__(el, selector) {
  var re = /^([a-z0-9_-]+)\\[([a-z0-9_-]+)=(["']?)([^"'\\]]+)\\3\\]$/i;
  var m = selector.match(re);
  if (!m) return false;
  var tag = m[1].toLowerCase(), attr = m[2], val = m[4];
  if (tag !== "*" && el.tagName && el.tagName.toLowerCase() !== tag) return false;
  return el.getAttribute(attr) === val;
}
function collectMatching__(el, matchFn, results) {
  if (matchFn(el)) results.push(el);
  if (el.children && el.children.length > 0) { for (var i = 0; i < el.children.length; i++) collectMatching__(el.children[i], matchFn, results); }
}
Element__.prototype.querySelectorAll = function (selector) {
  selector = String(selector || "").toLowerCase();
  if (selector === "#jsa" && this.ownerDocument && this.ownerDocument.__jsa__) return new NodeList__([this.ownerDocument.__jsa__]);
  if (selector.indexOf("meta[") === 0) {
    var results = [];
    if (this.children && this.children.length > 0) { for (var i = 0; i < this.children.length; i++) collectMatching__(this.children[i], function (el) { return matchesAttributeSelector__(el, selector); }, results); }
    return new NodeList__(results);
  }
  return new NodeList__([]);
};
Element__.prototype.querySelector = function (selector) { var list = this.querySelectorAll(selector); return list.length > 0 ? list[0] : null; };
Element__.prototype.getAttribute = function (name) { return this.attributes[String(name)] || null; };
Element__.prototype.setAttribute = function (name, value) { this.attributes[String(name)] = String(value); };
Element__.prototype.getBoundingClientRect = function () { return { width: 1, height: 1, top: 0, right: 1, bottom: 1, left: 0 }; };
Element__.prototype.addEventListener = function () {};
Element__.prototype.removeEventListener = function () {};
Element__.prototype.focus = function () {};
Element__.prototype.blur = function () {};
Element__.prototype.cloneNode = function () { return Object.create(this); };
function HTMLElement__() { Element__.apply(this, arguments); }
HTMLElement__.prototype = Object.create(Element__.prototype);
HTMLElement__.prototype.constructor = HTMLElement__;
function HTMLDivElement__() { HTMLElement__.apply(this, arguments); }
HTMLDivElement__.prototype = Object.create(HTMLElement__.prototype);
HTMLDivElement__.prototype.constructor = HTMLDivElement__;
function HTMLIFrameElement__() { HTMLElement__.apply(this, arguments); }
HTMLIFrameElement__.prototype = Object.create(HTMLElement__.prototype);
HTMLIFrameElement__.prototype.constructor = HTMLIFrameElement__;
function HTMLScriptElement__() { HTMLElement__.apply(this, arguments); }
HTMLScriptElement__.prototype = Object.create(HTMLElement__.prototype);
HTMLScriptElement__.prototype.constructor = HTMLScriptElement__;
function createElement__(tagName) {
  tagName = String(tagName || "").toLowerCase();
  var el;
  if (tagName === "div") el = new HTMLDivElement__();
  else if (tagName === "iframe") el = new HTMLIFrameElement__();
  else if (tagName === "script") el = new HTMLScriptElement__();
  else el = new Element__(tagName);
  Element__.call(el, tagName);
  return el;
}
var docLocation__ = { href: "https://duck.ai/", origin: __goOrigin, protocol: "https:", host: "duck.ai", hostname: "duck.ai", port: "", pathname: "/", search: "", hash: "" };
function makeDocument__() {
  var docEl = new Element__("html");
  var head = new Element__("head");
  var body = new Element__("body");
  docEl.ownerDocument = docEl; head.ownerDocument = head; body.ownerDocument = body;
  docEl.appendChild(head); docEl.appendChild(body);
  var doc = {
    documentElement: docEl, head: head, body: body, cookie: "", title: "", referrer: "",
    URL: "https://duck.com/", domain: "duck.com", readyState: "complete",
    visibilityState: "visible", hidden: false, defaultView: null, __jsa__: null,
    location: docLocation__,
    createElement: function (tagName) { var el = createElement__(tagName); el.ownerDocument = this; return el; },
    createTextNode: function () { return {}; }, createComment: function () { return {}; },
    createEvent: function () { return { initEvent: function () {} }; },
    dispatchEvent: function () { return true; },
    addEventListener: function () {}, removeEventListener: function () {},
    querySelectorAll: function (selector) { return docEl.querySelectorAll(selector); },
    querySelector: function (selector) { return selector === "#jsa" && this.__jsa__ ? this.__jsa__ : docEl.querySelector(selector); },
    getElementById: function (id) { return id === "jsa" && this.__jsa__ ? this.__jsa__ : null; },
  };
  docEl.ownerDocument = doc; head.ownerDocument = doc; body.ownerDocument = doc;
  return doc;
}
var doc__ = makeDocument__();
var contentDoc__ = makeDocument__();
var cspMeta__ = contentDoc__.createElement("meta");
cspMeta__.setAttribute("http-equiv", "Content-Security-Policy");
cspMeta__.setAttribute("content", "default-src 'none'; script-src 'unsafe-inline';");
contentDoc__.head.appendChild(cspMeta__);
var jsaFrame__ = doc__.createElement("iframe");
jsaFrame__.setAttribute("id", "jsa");
jsaFrame__.setAttribute("sandbox", "allow-scripts allow-same-origin");
jsaFrame__.style.cssText = "position: absolute; left: -9999px; top: -9999px;";
jsaFrame__.srcdoc = "<!DOCTYPE html>\\n<html>\\n<head>\\n<meta http-equiv=\\"Content-Security-Policy\\" content=\\"default-src 'none'; script-src 'unsafe-inline';\\">\\n</head>\\n<body></body>\\n</html>";
var contentWin__ = {
  Array: Array, Promise: Promise, Proxy: Proxy, Symbol: Symbol,
  Object: Object, JSON: JSON, Math: Math, Date: Date,
  String: String, Number: Number, Boolean: Boolean, RegExp: RegExp,
  Map: Map, Set: Set, WeakMap: WeakMap, WeakSet: WeakSet,
  Error: Error, TypeError: TypeError, RangeError: RangeError,
  ReferenceError: ReferenceError, SyntaxError: SyntaxError,
  EvalError: EvalError, URIError: URIError,
  Uint8Array: Uint8Array, Uint16Array: Uint16Array, Uint32Array: Uint32Array,
  Int8Array: Int8Array, Int16Array: Int16Array, Int32Array: Int32Array,
  Float32Array: Float32Array, Float64Array: Float64Array,
  ArrayBuffer: ArrayBuffer, DataView: DataView,
  TextEncoder: TextEncoder__,
  navigator: navigator__, document: contentDoc__,
  location: { href: "about:srcdoc", origin: "null", protocol: "about:", host: "", hostname: "", port: "", pathname: "srcdoc", search: "", hash: "" },
  btoa: function (v) { return __goBtoa(v); },
  atob: function (v) { return __goAtob(v); },
  setTimeout: function (fn) { if (typeof fn === "function") fn(); return 0; },
  clearTimeout: function () {}, setInterval: function () { return 0; }, clearInterval: function () {},
  addEventListener: function () {}, removeEventListener: function () {}, postMessage: function () {},
  getComputedStyle: function (el) { return el && el.style ? el.style : { getPropertyValue: function () { return ""; }, cssText: "" }; },
  screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 },
  crypto: { subtle: { digest: function () { return Promise.resolve(new ArrayBuffer(32)); } } },
  performance: { now: function () { var t = Date.now(); return t % 1000 + Math.random(); } },
  console: { log: function () {}, warn: function () {}, error: function () {}, info: function () {}, debug: function () {} },
  __jsaCallbacks__: {},
  constructor: function Window() {}, navigator: navigator__,
};
contentWin__.self = contentWin__;
contentWin__.window = contentWin__;
contentWin__.top = globalThis;
contentWin__.parent = globalThis;
contentWin__[Symbol.toStringTag] = "Window";
contentWin__.Window = function Window() {};
contentWin__.Window.prototype = contentWin__;
contentDoc__.defaultView = contentWin__;
jsaFrame__.contentDocument = contentDoc__;
jsaFrame__.contentWindow = contentWin__;
doc__.body.appendChild(jsaFrame__);
doc__.__jsa__ = jsaFrame__;
function defProp__(obj, name, value) { Object.defineProperty(obj, name, { value: value, writable: true, configurable: true }); }
defProp__(globalThis, "window", globalThis);
defProp__(globalThis, "self", globalThis);
defProp__(globalThis, "top", globalThis);
defProp__(globalThis, "document", doc__);
defProp__(globalThis, "location", docLocation__);
defProp__(globalThis, "navigator", navigator__);
defProp__(globalThis, "TextEncoder", TextEncoder__);
defProp__(globalThis, "Element", Element__);
defProp__(globalThis, "HTMLElement", HTMLElement__);
defProp__(globalThis, "HTMLDivElement", HTMLDivElement__);
defProp__(globalThis, "HTMLIFrameElement", HTMLIFrameElement__);
defProp__(globalThis, "HTMLScriptElement", HTMLScriptElement__);
defProp__(globalThis, "NodeList", NodeList__);
defProp__(globalThis, "__DDG_BE_VERSION__", "dev");
defProp__(globalThis, "__DDG_FE_CHAT_HASH__", "hash");
defProp__(globalThis, "Window", function Window() {});
try { defProp__(globalThis.Window, "prototype", globalThis); } catch (e) {}
if (typeof Symbol !== "undefined" && Symbol.toStringTag) { defProp__(globalThis, Symbol.toStringTag, "Window"); defProp__(contentWin__, Symbol.toStringTag, "Window"); }
defProp__(globalThis, "btoa", function (v) { return __goBtoa(v); });
defProp__(globalThis, "atob", function (v) { return __goAtob(v); });
defProp__(globalThis, "getComputedStyle", function (el) { return el && el.style ? el.style : { getPropertyValue: function () { return ""; }, cssText: "" }; });
defProp__(globalThis, "setTimeout", function (fn) { if (typeof fn === "function") fn(); return 0; });
defProp__(globalThis, "clearTimeout", function () {});
defProp__(globalThis, "setInterval", function () { return 0; });
defProp__(globalThis, "clearInterval", function () {});
defProp__(globalThis, "performance", { now: function () { var t = Date.now(); return t % 1000 + Math.random(); }, timing: { navigationStart: Date.now() - 1000 }, memory: { jsHeapSizeLimit: 2172649472, totalJSHeapSize: 10000000, usedJSHeapSize: 8000000 }, timeOrigin: Date.now() - 1000 });
defProp__(globalThis, "crypto", { subtle: { digest: function () { return Promise.resolve(new ArrayBuffer(32)); } }, getRandomValues: function (arr) { for (var i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; } });
defProp__(globalThis, "screen", { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 });
defProp__(globalThis, "history", { length: 1, state: null, scrollRestoration: "auto" });
defProp__(globalThis, "localStorage", (function () { var s = {}; return { getItem: function (k) { return s[k] !== undefined ? s[k] : null; }, setItem: function (k, v) { s[String(k)] = String(v); }, removeItem: function (k) { delete s[String(k)]; }, clear: function () { s = {}; }, get length() { return Object.keys(s).length; }, key: function (i) { return Object.keys(s)[i] || null; } }; })());
defProp__(globalThis, "sessionStorage", (function () { var s = {}; return { getItem: function (k) { return s[k] !== undefined ? s[k] : null; }, setItem: function (k, v) { s[String(k)] = String(v); }, removeItem: function (k) { delete s[String(k)]; }, clear: function () { s = {}; }, get length() { return Object.keys(s).length; }, key: function (i) { return Object.keys(s)[i] || null; } }; })());
defProp__(globalThis, "console", { log: function () {}, warn: function () {}, error: function () {}, info: function () {}, debug: function () {} });
defProp__(globalThis, "XMLHttpRequest", function () { this.open = function () {}; this.send = function () {}; this.setRequestHeader = function () {}; this.abort = function () {}; this.readyState = 4; this.status = 200; this.responseText = ""; });
defProp__(globalThis, "fetch", function () { return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); }, headers: { get: function () { return null; } } }); });
defProp__(globalThis, "URL", function (url) { var u = { href: url, protocol: "https:", host: "", hostname: "", port: "", pathname: "/", search: "", hash: "", origin: __goOrigin }; return u; });
defProp__(globalThis, "URLSearchParams", function () { this.get = function () { return null; }; this.set = function () {}; this.keys = function () { return []; }; });
defProp__(globalThis, "requestAnimationFrame", function (fn) { if (typeof fn === "function") fn(0); return 0; });
defProp__(globalThis, "cancelAnimationFrame", function () {});
defProp__(globalThis, "matchMedia", function () { return { matches: false, addListener: function () {}, removeListener: function () {}, addEventListener: function () {}, removeEventListener: function () {} }; });
defProp__(globalThis, "ResizeObserver", function () { this.observe = function () {}; this.disconnect = function () {}; this.unobserve = function () {}; });
defProp__(globalThis, "IntersectionObserver", function () { this.observe = function () {}; this.disconnect = function () {}; this.takeRecords = function () { return []; }; });
defProp__(globalThis, "MutationObserver", function () { this.observe = function () {}; this.disconnect = function () {}; this.takeRecords = function () { return []; }; });
defProp__(globalThis, "Image", function () { var img = { width: 0, height: 0, src: "", onload: null, onerror: null, naturalWidth: 0, naturalHeight: 0, complete: false }; return img; });
try { Object.defineProperty(NodeList, "name", { value: "NodeList", configurable: true }); } catch (e) {}
try { Object.defineProperty(Element, "name", { value: "Element", configurable: true }); } catch (e) {}
try { Object.defineProperty(HTMLElement, "name", { value: "HTMLElement", configurable: true }); } catch (e) {}
try { Object.defineProperty(HTMLDivElement, "name", { value: "HTMLDivElement", configurable: true }); } catch (e) {}
try { Object.defineProperty(HTMLIFrameElement, "name", { value: "HTMLIFrameElement", configurable: true }); } catch (e) {}
try { Object.defineProperty(HTMLScriptElement, "name", { value: "HTMLScriptElement", configurable: true }); } catch (e) {}
})();
`;

const VQD_RESULT_MUTATION = `(function () {
if (!__vqd_result || typeof __vqd_result !== "object") throw new Error("VQD hash script did not return an object");
if (!Array.isArray(__vqd_result.client_hashes)) throw new Error("VQD hash script did not return client_hashes");
var hashed = __vqd_result.client_hashes.map(function (value) { return __goSha256Base64(String(value)); });
var meta = {};
if (__vqd_result.meta && typeof __vqd_result.meta === "object") { for (var k in __vqd_result.meta) { if (Object.prototype.hasOwnProperty.call(__vqd_result.meta, k)) meta[k] = __vqd_result.meta[k]; } }
meta.origin = __goOrigin;
meta.stack = __goStack;
meta.duration = __vqdDurationMs;
var result = {};
for (var k in __vqd_result) { if (Object.prototype.hasOwnProperty.call(__vqd_result, k)) { if (k !== "client_hashes" && k !== "meta") result[k] = __vqd_result[k]; } }
result.client_hashes = hashed;
result.meta = meta;
return JSON.stringify(result);
})();
`;

async function solveDuckVqdChallenge(challenge, { feVersion, vqdStack }) {
  const jsCode = fromBase64(challenge);
  const sandbox = {
    __goUserAgent: USER_AGENT,
    __goOrigin: DUCKAI_ORIGIN,
    __goStack: vqdStack,
    __goSha256Base64: sha256Base64,
    __goBtoa: toBase64,
    __goAtob: (value) => { try { return fromBase64(value); } catch { return ''; } },
  };
  vm.createContext(sandbox);
  const startMs = Date.now();
  let value = vm.runInContext(`${VQD_BROWSER_PRELUDE}\n${jsCode}`, sandbox, { timeout: 10_000 });
  if (value && typeof value.then === 'function') value = await value;
  sandbox.__vqd_result = value;
  sandbox.__vqdDurationMs = String(Date.now() - startMs);
  const payload = vm.runInContext(VQD_RESULT_MUTATION, sandbox, { timeout: 10_000 });
  return toBase64(payload);
}

function timeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, clear: () => clearTimeout(timer) };
}

export class DuckAiClient {
  constructor({ fetchImpl = globalThis.fetch, origin = DUCKAI_ORIGIN, timeoutMs = DEFAULT_TIMEOUT_MS, sessionId = null, persistPath = null } = {}) {
    this.fetch = fetchImpl;
    this.origin = origin.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.sessionId = sessionId || randomUUID();
    this.cookies = '';
    this.vqd = null;
    this.frontendMeta = null;
    this.models = [];
    this.bootstrapPromise = null;
    // Duck.ai throttles challenge issuance hard, and the native web UI avoids it
    // by keeping one long-lived browser session. Persisting cookies + solved
    // token across process restarts gives modelrelay the same property: solve
    // once, reuse until Duck.ai invalidates it.
    this.persistPath = persistPath;
    if (this.persistPath) this.loadPersistedSession();
  }

  loadPersistedSession() {
    try {
      const saved = JSON.parse(readFileSync(this.persistPath, 'utf8'));
      if (typeof saved?.cookies === 'string' && saved.cookies) this.cookies = saved.cookies;
      if (typeof saved?.vqd === 'string' && saved.vqd) this.vqd = saved.vqd;
      if (typeof saved?.sessionId === 'string' && saved.sessionId) this.sessionId = saved.sessionId;
      if (saved?.frontendMeta && typeof saved.frontendMeta === 'object') this.frontendMeta = saved.frontendMeta;
    } catch { /* first run or unreadable file */ }
  }

  persistSession() {
    if (!this.persistPath || !this.vqd) return;
    try {
      writeFileSync(this.persistPath, JSON.stringify({ cookies: this.cookies, vqd: this.vqd, sessionId: this.sessionId, frontendMeta: this.frontendMeta }));
    } catch { /* best-effort */ }
  }

  resetSession() {
    this.cookies = '';
    this.vqd = null;
    this.bootstrapPromise = null;
    if (this.persistPath) { try { rmSync(this.persistPath, { force: true }); } catch { /* best-effort */ } }
  }

  async bootstrap() {
    // Reuse the solved challenge token for the whole session. Duck.ai rate-limits
    // challenge issuance, so re-solving on every ping would quickly get us 418s.
    if (this.vqd) return { ok: true, status: 200, body: '' };
    if (this.bootstrapPromise) return this.bootstrapPromise;
    this.bootstrapPromise = (async () => {
      const { controller, clear } = timeoutSignal(this.timeoutMs);
      try {
        const response = await this.fetch(`${this.origin}${STATUS_PATH}`, {
          method: 'GET',
          headers: { accept: '*/*', 'x-vqd-accept': '1', 'user-agent': USER_AGENT, ...BROWSER_HINT_HEADERS, ...(this.cookies ? { cookie: this.cookies } : {}) },
          signal: controller.signal,
        });
        const body = await response.text();
        this.cookies = mergeDuckAiCookies(this.cookies, response.headers);
        if (!response.ok) throw new Error(`Duck.ai session bootstrap failed (HTTP ${response.status}).`);
        const challenge = getHeader(response.headers, 'x-vqd-hash-1');
        if (!challenge) throw new Error('Duck.ai session bootstrap failed (missing x-vqd-hash-1 challenge).');
        // Derive the current x-fe-version and vqd stack from the live frontend;
        // fall back to known-good constants if the probe fails.
        try { this.frontendMeta = await resolveDuckAiFrontendMeta(this.fetch); }
        catch { this.frontendMeta ||= { feVersion: FALLBACK_FE_VERSION, vqdStack: FALLBACK_VQD_STACK }; }
        this.vqd = await solveDuckVqdChallenge(challenge, this.frontendMeta);
        this.persistSession();
        return { ok: true, status: response.status, body };
      } finally { clear(); this.bootstrapPromise = null; }
    })();
    return this.bootstrapPromise;
  }

  async discoverModels() {
    try {
      const bootstrap = await this.bootstrap();
      const found = extractDuckAiModels(parseJsonSafely(bootstrap.body));
      this.models = found.length > 0 ? found : DUCKAI_MODELS.map(([modelId, label]) => ({ modelId, label }));
    } catch {
      this.models = DUCKAI_MODELS.map(([modelId, label]) => ({ modelId, label }));
    }
    return this.models;
  }

  async chat(body, { stream = false, raw = false, retrySession = true, sameToken = 2 } = {}) {
    await this.bootstrap();
    const request = buildDuckAiRequest(body, this.sessionId);
    if (!request.messages.some(message => message.role === 'user' && asText(message.content))) {
      throw new Error('Duck.ai request requires a non-empty user message.');
    }
    const { controller, clear } = timeoutSignal(this.timeoutMs);
    try {
      const response = await this.fetch(`${this.origin}${CHAT_PATH}`, {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json',
          origin: this.origin,
          referer: `${this.origin}/`,
          'user-agent': USER_AGENT,
          ...BROWSER_HINT_HEADERS,
          ...(this.cookies ? { cookie: this.cookies } : {}),
          'x-vqd-hash-1': this.vqd,
          'x-ddg-journey-id': randomBytes(16).toString('hex'),
          'x-fe-signals': buildFeSignals(),
          'x-fe-version': this.frontendMeta?.feVersion || FALLBACK_FE_VERSION,
          priority: 'u=1, i',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      this.cookies = mergeDuckAiCookies(this.cookies, response.headers);
      this.persistSession();
      if (!response.ok && [401, 403, 418].includes(response.status)) {
        // 418 ERR_CHALLENGE: a freshly-solved token is often rejected on its first
        // use (challenge propagation). Retry the same token a couple times before
        // spending a new challenge; only re-solve when it keeps failing.
        if (response.status === 418 && sameToken > 0) {
          return this.chat(body, { stream, raw, retrySession, sameToken: sameToken - 1 });
        }
        if (retrySession) {
          this.resetSession();
          return this.chat(body, { stream, raw, retrySession: false });
        }
      }
      if (raw) return { response, text: null, category: response.ok ? null : classifyDuckAiError(response.status, '') };
      const text = await response.text();
      return { response, text, category: response.ok ? null : classifyDuckAiError(response.status, text) };
    } finally { clear(); }
  }
}

export const DUCKAI_DEFAULT_MODEL = DEFAULT_MODEL;
export const DUCKAI_ORIGIN_URL = DUCKAI_ORIGIN;
