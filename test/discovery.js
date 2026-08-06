import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractOpenRouterModelRecords, toOpenRouterModelMeta } from '../lib/server.js'

describe('OpenRouter model discovery', () => {
  it('extracts records from various payload shapes', () => {
    assert.deepEqual(extractOpenRouterModelRecords(null), [])
    assert.deepEqual(extractOpenRouterModelRecords({}), [])
    assert.deepEqual(extractOpenRouterModelRecords([]), [])
    
    const data = [{ id: 'a' }, { id: 'b' }]
    assert.deepEqual(extractOpenRouterModelRecords(data), data)
    assert.deepEqual(extractOpenRouterModelRecords({ data }), data)
  })

  it('converts records to model meta, filtering for free models', () => {
    const freeRecord = {
      id: 'google/gemma-7b-it:free',
      name: 'Gemma 7B IT (free)',
      context_length: 8192
    }
    const paidRecord = {
      id: 'openai/gpt-4o',
      name: 'GPT-4o'
    }

    const freeMeta = toOpenRouterModelMeta(freeRecord)
    assert.ok(freeMeta)
    assert.equal(freeMeta.modelId, 'google/gemma-7b-it:free')
    assert.equal(freeMeta.label, 'Gemma 7B IT')
    assert.equal(freeMeta.ctx, '8192')
    assert.equal(freeMeta.ctxSource, 'provider-reported')
    assert.equal(freeMeta.providerKey, 'openrouter')

    const paidMeta = toOpenRouterModelMeta(paidRecord)
    assert.equal(paidMeta, null)
  })

  it('cleans model labels by removing lab prefix and (free) suffix', () => {
    const record = {
      id: 'google/gemma-7b-it:free',
      name: 'Google: Gemma 7B IT (free)',
      context_length: 8192
    }
    const meta = toOpenRouterModelMeta(record)
    assert.equal(meta.label, 'Gemma 7B IT')

    assert.equal(toOpenRouterModelMeta({ id: 'a:free', name: 'Meta: Llama 3 (free)' }).label, 'Llama 3')
    assert.equal(toOpenRouterModelMeta({ id: 'b:free', name: 'Mistral: Mistral 7B free' }).label, 'Mistral 7B')
    assert.equal(toOpenRouterModelMeta({ id: 'c:free', name: 'Giga Potato' }).label, 'Giga Potato')
  })

  it('handles missing or malformed fields in records', () => {
    assert.equal(toOpenRouterModelMeta({ id: 'only-id:free' }).label, 'only-id:free')
    assert.equal(toOpenRouterModelMeta({ id: 'only-id:free' }).ctx, null)
    assert.equal(toOpenRouterModelMeta({ id: 'only-id:free' }).ctxSource, null)
  })
})
