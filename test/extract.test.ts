import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { Browser, Page } from 'puppeteer' with { 'resolution-mode': 'import' }
import { extractProducts, readPageCount } from '../src/scraper/extract'
import { DriftCollector, normalize } from '../src/scraper/normalize'
import { validatePart } from '../src/scraper/validate'

/**
 * These run the real extraction code against a real Chromium, on a fixture
 * that reproduces PCPartPicker's row markup. That makes the selectors
 * themselves testable without touching the network — which matters because
 * the selectors are the part most likely to rot.
 */

const FIXTURE = readFileSync(
	join(__dirname, 'fixtures', 'memory-rows.html'),
	'utf8'
)

describe('extract', () => {
	let browser: Browser
	let page: Page

	before(async () => {
		const puppeteer = (await import('puppeteer')).default
		browser = await puppeteer.launch({
			headless: true,
			args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
		})
		page = await browser.newPage()
		await page.setContent(FIXTURE, { waitUntil: 'domcontentloaded' })
	})

	after(async () => {
		await browser?.close()
	})

	it('finds every product row', async () => {
		const rows = await extractProducts(page)
		assert.equal(rows.length, 5)
	})

	it('reads the highest page number, not the last list item', async () => {
		assert.equal(await readPageCount(page), 17)
	})

	it('captures name, product path and id', async () => {
		const [first] = await extractProducts(page)
		assert.equal(
			first!.name,
			'G.Skill Flare X5 32 GB (2 x 16 GB) DDR5-6000 CL30 Memory'
		)
		assert.equal(first!.path, '/product/4W9RsY/gskill-flare-x5-32-gb-ddr5-6000')
		assert.equal(first!.id, '4W9RsY')
	})

	it('reads spec values that are wrapped in an element', async () => {
		const rows = await extractProducts(page)
		const wrapped = rows.find((r) => r.name?.startsWith('TEAMGROUP'))
		const speed = wrapped!.specs.find((s) => s.label === 'Speed')

		// The legacy scraper read `childNodes[1]`, which returns the <span>
		// node rather than its text and breaks on markup like this.
		assert.equal(speed!.value, 'DDR5-7200')
	})

	it('reports an empty spec value as null, not empty string', async () => {
		const rows = await extractProducts(page)
		const kingston = rows.find((r) => r.name?.startsWith('Kingston'))
		const pricePerGb = kingston!.specs.find((s) => s.label === 'Price / GB')

		assert.equal(pricePerGb!.value, null)
	})

	it('survives a row with no product anchor', async () => {
		const rows = await extractProducts(page)
		const unlinked = rows.find((r) => r.name?.startsWith('Unlinked'))

		assert.equal(unlinked!.path, null)
		assert.equal(unlinked!.id, null)
		assert.equal(unlinked!.specs.length, 3)
	})

	it('does not throw on an unmapped spec label', async () => {
		const rows = await extractProducts(page)
		const drift = new DriftCollector()

		// The whole point: a new PCPartPicker column must not abort the run.
		const parts = rows.map((raw) => normalize('memory', raw, drift).part)

		assert.equal(parts.length, 5)
		assert.equal(drift.size, 1)

		const [record] = drift.forEndpoint('memory')
		assert.equal(record!.label, 'Heat Spreader')
		assert.equal(record!.sampleValue, 'Yes')
	})

	it('preserves the unmapped value rather than dropping it', async () => {
		const rows = await extractProducts(page)
		const drift = new DriftCollector()
		const corsair = rows.find((r) => r.name?.startsWith('Corsair'))!

		const { part } = normalize('memory', corsair, drift)

		assert.equal(part['heat_spreader'], 'Yes')
	})

	it('serializes known specs the same way the published dataset does', async () => {
		const rows = await extractProducts(page)
		const drift = new DriftCollector()
		const { part } = normalize('memory', rows[0]!, drift)

		assert.equal(part['name'], 'G.Skill Flare X5 32 GB (2 x 16 GB) DDR5-6000 CL30 Memory')
		assert.equal(part['price'], 94.99)
		assert.deepEqual(part['speed'], [5, 6000])
		assert.deepEqual(part['modules'], [2, 16])
		assert.equal(part['price_per_gb'], 2.968)
		assert.equal(part['color'], 'Black')
		assert.equal(part['first_word_latency'], 10)
		assert.equal(part['cas_latency'], 30)
	})

	it('adds identity fields the legacy dataset lacks', async () => {
		const rows = await extractProducts(page)
		const drift = new DriftCollector()
		const { part } = normalize('memory', rows[0]!, drift)

		assert.equal(part['id'], '4W9RsY')
		assert.equal(
			part['url'],
			'https://pcpartpicker.com/product/4W9RsY/gskill-flare-x5-32-gb-ddr5-6000'
		)
	})

	it('treats a missing price as null', async () => {
		const rows = await extractProducts(page)
		const drift = new DriftCollector()
		const kingston = rows.find((r) => r.name?.startsWith('Kingston'))!

		assert.equal(normalize('memory', kingston, drift).part['price'], null)
	})

	it('flags mapped labels the page stopped rendering', async () => {
		const rows = await extractProducts(page)
		const drift = new DriftCollector()
		for (const raw of rows) normalize('memory', raw, drift)

		// Every mapped memory label appears somewhere in the fixture.
		assert.deepEqual(drift.missingFor('memory'), [])

		// Nothing was observed for motherboard, so absence is unknowable and
		// must not be reported — otherwise a resumed run reports every column
		// of every endpoint as removed.
		assert.deepEqual(drift.missingFor('motherboard'), [])
	})

	it('passes validation for well-formed rows', async () => {
		const rows = await extractProducts(page)
		const drift = new DriftCollector()
		const { part } = normalize('memory', rows[0]!, drift)

		assert.equal(validatePart(part).ok, true)
	})
})
