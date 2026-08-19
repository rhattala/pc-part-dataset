import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseArgs } from '../src/scraper/config'
import { autoKey, DriftCollector, normalize } from '../src/scraper/normalize'
import { outputCsv, outputJsonLines } from '../src/output'
import { validatePart } from '../src/scraper/validate'
import { serializeNumber } from '../src/serializers'
import type { RawProduct } from '../src/types'

const raw = (over: Partial<RawProduct> = {}): RawProduct => ({
	name: 'Test Kit 16 GB',
	path: '/product/abc123/test-kit',
	id: 'abc123',
	priceText: '$49.99',
	ratingText: '(12)',
	specs: [],
	...over,
})

describe('autoKey', () => {
	it('derives a snake_case key from a spec label', () => {
		assert.equal(autoKey('Heat Spreader'), 'heat_spreader')
		assert.equal(autoKey('Price / GB'), 'price_gb')
		assert.equal(autoKey('  ECC / Registered  '), 'ecc_registered')
	})
})

describe('serializeNumber', () => {
	it('pulls a single number out of a price', () => {
		assert.equal(serializeNumber('$94.99'), 94.99)
	})

	it('returns a tuple for values with two numbers', () => {
		assert.deepEqual(serializeNumber('DDR5-6000'), [5, 6000])
	})

	it('returns null when there is no number', () => {
		assert.equal(serializeNumber('—'), null)
	})
})

describe('normalize', () => {
	it('never throws on an unmapped label', () => {
		const drift = new DriftCollector()
		const { part } = normalize(
			'memory',
			raw({ specs: [{ label: 'Brand New Column', value: '42' }] }),
			drift
		)

		assert.equal(part['brand_new_column'], '42')
		assert.equal(drift.size, 1)
	})

	it('counts repeats of the same unmapped label once', () => {
		const drift = new DriftCollector()
		for (let i = 0; i < 5; i++)
			normalize(
				'memory',
				raw({ specs: [{ label: 'Brand New Column', value: 'x' }] }),
				drift
			)

		assert.equal(drift.size, 1)
		assert.equal(drift.forEndpoint('memory')[0]!.count, 5)
	})

	it('does not let an auto key clobber a mapped field', () => {
		const drift = new DriftCollector()
		const { part } = normalize(
			'memory',
			raw({
				specs: [
					{ label: 'Color', value: 'Black' },
					// Would derive to `color` and overwrite the mapped value.
					{ label: 'color', value: 'SHOULD NOT WIN' },
				],
			}),
			drift
		)

		assert.equal(part['color'], 'Black')
	})

	it('keeps the raw value when a custom serializer throws', () => {
		const drift = new DriftCollector()
		const { part, warnings } = normalize(
			'internal-hard-drive',
			raw({ specs: [{ label: 'Capacity', value: 'not a size' }] }),
			drift
		)

		assert.equal(part['capacity'], null)
		assert.equal(warnings.length, 0)
	})

	it('records a warning for a nameless row', () => {
		const drift = new DriftCollector()
		const { warnings } = normalize('memory', raw({ name: null }), drift)

		assert.ok(warnings.some((w) => w.includes('no name')))
	})
})

describe('validatePart', () => {
	it('rejects a row with no name', () => {
		assert.equal(validatePart({ name: '', id: null, url: null, price: null }).ok, false)
	})

	it('accepts a null id and url', () => {
		assert.equal(
			validatePart({ name: 'Thing', id: null, url: null, price: 10 }).ok,
			true
		)
	})

	it('accepts extra category-specific fields', () => {
		assert.equal(
			validatePart({
				name: 'Thing',
				id: 'a',
				url: 'https://pcpartpicker.com/product/a/x',
				price: null,
				anything_else: [1, 2],
			}).ok,
			true
		)
	})
})

describe('outputCsv', () => {
	it('unions keys across rows instead of trusting the first row', () => {
		const csv = outputCsv([
			{ name: 'A', price: 1 },
			{ name: 'B', price: 2, heat_spreader: 'Yes' },
		])

		const [header, rowA, rowB] = csv.trim().split('\n')

		assert.equal(header, 'name,price,heat_spreader')
		// Row A must pad the column it does not have, not shift left.
		assert.equal(rowA, 'A,1,')
		assert.equal(rowB, 'B,2,Yes')
	})

	it('quotes values containing commas and quotes', () => {
		const csv = outputCsv([{ name: 'A, "B"' }])
		assert.equal(csv.trim().split('\n')[1], '"A, ""B"""')
	})

	it('renders arrays as a quoted list', () => {
		const csv = outputCsv([{ speed: [5, 6000] }])
		assert.equal(csv.trim().split('\n')[1], '"5,6000"')
	})

	it('returns empty string for no rows', () => {
		assert.equal(outputCsv([]), '')
	})
})

describe('outputJsonLines', () => {
	it('emits one object per line', () => {
		const jsonl = outputJsonLines([{ a: 1 }, { a: 2 }])
		assert.equal(jsonl, '{"a":1}\n{"a":2}')
	})
})

describe('parseArgs', () => {
	it('defaults to every endpoint', () => {
		assert.equal(parseArgs([], {}).endpoints.length, 25)
	})

	it('accepts positional endpoints', () => {
		assert.deepEqual(parseArgs(['cpu', 'memory'], {}).endpoints, ['cpu', 'memory'])
	})

	it('rejects an unknown endpoint instead of silently scraping a 404', () => {
		assert.throws(() => parseArgs(['cpus'], {}), /Unknown endpoint/)
	})

	it('reads flags', () => {
		const config = parseArgs(['--concurrency=7', '--headless=false'], {})
		assert.equal(config.concurrency, 7)
		assert.equal(config.headless, false)
	})

	it('lets flags win over environment', () => {
		const config = parseArgs(['--concurrency=7'], { SCRAPER_CONCURRENCY: '2' })
		assert.equal(config.concurrency, 7)
	})

	it('falls back to environment', () => {
		assert.equal(parseArgs([], { SCRAPER_CONCURRENCY: '2' }).concurrency, 2)
	})
})

describe('DriftCollector.missingFor', () => {
	it('reports a mapped label the page stopped rendering', () => {
		const drift = new DriftCollector()
		drift.observe('memory', 'Speed')

		assert.ok(drift.missingFor('memory').includes('CAS Latency'))
		assert.ok(!drift.missingFor('memory').includes('Speed'))
	})

	it('reports nothing when no label was observed at all', () => {
		// A fully resumed run normalizes no rows; "every column is gone" would
		// be a false alarm rather than a finding.
		assert.deepEqual(new DriftCollector().missingFor('memory'), [])
	})
})

describe('normalize identity fields', () => {
	it('resolves a relative product path to an absolute url', () => {
		const drift = new DriftCollector()
		const { part } = normalize('memory', raw(), drift)

		assert.equal(part['id'], 'abc123')
		assert.equal(part['url'], 'https://pcpartpicker.com/product/abc123/test-kit')
	})

	it('does not throw on an href the URL parser rejects', () => {
		const drift = new DriftCollector()
		// `new URL('http://[', origin)` throws. One malformed link must not
		// abort the category.
		const { part, warnings } = normalize('memory', raw({ path: 'http://[' }), drift)

		assert.equal(part['url'], null)
		assert.ok(warnings.some((w) => w.includes('unparseable product href')))
	})

	it('leaves url null when there is no anchor', () => {
		const drift = new DriftCollector()
		const { part } = normalize('memory', raw({ path: null, id: null }), drift)

		assert.equal(part['url'], null)
		assert.equal(part['id'], null)
	})
})
