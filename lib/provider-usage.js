/**
 * @file lib/provider-usage.js
 * @description Normalization, selection, and serialization of provider-reported
 * usage reports (free-tier quotas, credit balances) fetched from provider usage
 * endpoints or the OpenRouter key endpoint.
 */

const PUBLIC_FIELDS = [
  'providerKey', 'metric', 'used', 'limit', 'remaining', 'unit', 'resetAt',
  'scope', 'model', 'project', 'account', 'window', 'source', 'fetchedAt',
  'freshness', 'error',
]

const toNum = (value) => {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const toResetAt = (value) => {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const number = Number(value)
  if (Number.isFinite(number)) {
    if (number >= 1e12) return Math.round(number)
    if (number >= 1e9) return Math.round(number * 1000)
    return Date.now() + Math.round(number * 1000)
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

const firstValue = (item, keys) => {
  for (const key of keys) {
    if (key && item[key] != null) return item[key]
  }
  return null
}

const hasAny = (item, keys) => keys.some(key => key && item[key] != null)

const METRIC_FIELDS = {
  requests: {
    used: ['requestsUsed', 'requestsUsage', 'requestCount', 'dailyUsage', 'dailyRequests', 'quotaUsed'],
    limit: ['requestsLimit', 'requestLimit', 'dailyLimit', 'dailyRequestsLimit', 'quotaLimit'],
    remaining: ['requestsRemaining', 'requestRemaining', 'dailyRemaining', 'quotaRemaining'],
    unit: 'requests',
  },
  tokens: {
    used: ['tokensUsed', 'tokensUsage', 'tokenUsage'],
    limit: ['tokensLimit', 'tokenLimit'],
    remaining: ['tokensRemaining', 'tokenRemaining'],
    unit: 'tokens',
  },
  credits: {
    used: ['creditsUsed', 'creditUsage', 'balanceUsed', 'cost', 'quotaUsed'],
    limit: ['creditsLimit', 'creditLimit', 'balanceLimit', 'quotaLimit'],
    remaining: ['creditsRemaining', 'creditRemaining', 'balanceRemaining', 'quotaRemaining'],
    unit: 'credits',
  },
}

const explicitMetric = (item) => {
  const metric = String(item.metric ?? item.type ?? item.unit ?? item.measure ?? '').toLowerCase()
  if (/credit|balance|cost/.test(metric)) return 'credits'
  if (/token/.test(metric)) return 'tokens'
  if (/request|call|generation|daily/.test(metric)) return 'requests'
  return null
}

const metricsFor = (item) => {
  const explicit = explicitMetric(item)
  if (explicit) return [explicit]
  const found = Object.entries(METRIC_FIELDS)
    .filter(([, fields]) => hasAny(item, [...fields.used, ...fields.limit, ...fields.remaining]))
    .map(([metric]) => metric)
  return found.length > 0 ? found : ['requests']
}

const normalizeOne = (providerKey, item, metric, options) => {
  const fields = METRIC_FIELDS[metric]
  const genericUsed = ['used', 'usage']
  const genericLimit = ['limit']
  const genericRemaining = ['remaining']
  const useGeneric = explicitMetric(item) != null || metric === 'requests' && !hasAny(item, [...fields.used, ...fields.limit, ...fields.remaining])
  const used = toNum(firstValue(item, [
    ...(useGeneric ? genericUsed : []), ...fields.used,
    ...(metric === 'credits' ? ['creditsUsed'] : []),
  ]))
  const limit = toNum(firstValue(item, [
    ...(useGeneric ? genericLimit : []), ...fields.limit,
    ...(metric === 'credits' ? ['creditLimit'] : []),
  ]))
  let remaining = toNum(firstValue(item, [
    ...(useGeneric ? genericRemaining : []), ...fields.remaining,
    ...(metric === 'credits' ? ['creditRemaining'] : []),
  ]))
  let derivedUsed = used
  if (derivedUsed == null && limit != null && remaining != null) derivedUsed = limit - remaining
  if (remaining == null && limit != null && derivedUsed != null) remaining = limit - derivedUsed

  const report = {
    providerKey,
    metric,
    used: derivedUsed,
    limit,
    remaining,
    model: item.model != null ? String(item.model) : null,
    project: item.project ?? item.projectId ?? null,
    account: item.account ?? options.account ?? null,
    scope: item.scope != null ? String(item.scope) : 'account',
    unit: item.unit ?? fields.unit,
    resetAt: toResetAt(item.resetAt ?? item.reset ?? item.resetTime ?? item.windowReset),
    window: item.window ?? item.period ?? item.windowType ?? null,
    source: options.source ?? item.source ?? null,
    fetchedAt: options.fetchedAt ?? null,
    freshness: options.freshness ?? null,
    error: options.error ?? null,
  }
  const hasSignal = report.used != null || report.limit != null || report.remaining != null || report.resetAt != null
  return hasSignal ? report : null
}

// Accepts a single payload, an array, or an envelope like { data: [...] }.
// Provider field aliases are normalized without inventing a limit or usage value.
export const normalizeProviderUsageReport = (providerKey, raw, options = {}) => {
  let items
  if (Array.isArray(raw)) {
    items = raw
  } else if (raw && typeof raw === 'object') {
    const hasDirectFields = [
      'used', 'usage', 'limit', 'remaining', 'resetAt', 'reset', 'creditsUsed',
      'creditLimit', 'creditRemaining', 'requestsUsed', 'requestsLimit',
      'requestsRemaining', 'tokensUsed', 'tokensLimit', 'tokensRemaining',
      'dailyUsage', 'dailyLimit', 'quotaUsed', 'quotaLimit', 'quotaRemaining',
      'unit', 'metric', 'scope',
    ].some(key => raw[key] != null)
    if (!hasDirectFields && raw.data != null && typeof raw.data === 'object') {
      items = Array.isArray(raw.data) ? raw.data : [raw.data]
    } else {
      items = [raw]
    }
  } else {
    items = []
  }

  return items.flatMap(item => metricsFor(item)
    .map(metric => normalizeOne(providerKey, item, metric, options))
    .filter(Boolean))
}

export const selectProviderUsageReport = (reports, { model } = {}) => {
  if (!Array.isArray(reports)) return null
  if (model != null) return reports.find(report => report && report.model === model) || null
  return reports.find(report => report && report.model == null) || reports[0] || null
}

export const serializeProviderUsage = (reports) => {
  if (!Array.isArray(reports)) return []
  return reports.map((report) => {
    if (!report) return null
    const output = {}
    for (const field of PUBLIC_FIELDS) {
      if (report[field] != null) output[field] = report[field]
    }
    return output
  }).filter(Boolean)
}
