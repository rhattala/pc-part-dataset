import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { proxyServerArg } from '../src/scraper/browser'
import { parseArgs } from '../src/scraper/config'
import { DriftCollector, normalize } from '../src/scraper/normalize'
import { SnapshotStore } from '../src/scraper/store'
import { outputCsv } from '../src/output'
import type { RawProduct } from '../src/types'

/** Regressions for issues found in code review of the scraper rewrite. */

const raw = (over: Partial<RawProduct> = {}): RawProduct => ({
	name: 'Test Kit 16 GB',
	path: '/product/abc123/test-kit',
	id: 'abc123',
	priceText: '$49.99',
	ratingText: null,
	specs: [],
	...over,
})

describe('checkpoint concurrency', () => {
	let dir: string

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), 'pcpart-store-'))
	})

	after(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('does not lose entries when endpoints append concurrently', async () => {
		const store = await SnapshotStore.open(dir, null)

		// Endpoints run in a pool, so appends interleave. A read-modify-write
		// against the file loses entries; a lost entry makes --resume
		// re-scrape a page whose rows are already in the JSONL.
		await Promise.all([
			...Array.from({ length: 10 }, (_, i) =>
				store.appendPage('memory', i + 1, [{ name: `m${i}` }])
			),
			...Array.from({ length: 10 }, (_, i) =>
				store.appendPage('cpu', i + 1, [{ name: `c${i}` }])
			),
		])

		const onDisk = JSON.parse(
			await readFile(join(store.runDir, 'checkpoint.json'), 'utf8')
		)

		assert.equal(onDisk.memory.length, 10)
		assert.equal(onDisk.cpu.length, 10)
		assert.deepEqual([...onDisk.memory].sort((a, b) => a - b), [
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
		])
	})

	it('reloads a written checkpoint so a resumed run skips those pages', async () => {
		const store = await SnapshotStore.open(dir, null)
		await store.appendPage('memory', 7, [{ name: 'x' }])

		const resumed = await SnapshotStore.open(dir, store.runId)
		assert.deepEqual(resumed.readCheckpoint()['memory'], [7])
	})

	it('finalizes JSONL into a parseable array', async () => {
		const store = await SnapshotStore.open(dir, null)
		await store.appendPage('memory', 1, [{ name: 'a' }, { name: 'b' }])
		await store.appendPage('memory', 2, [{ name: 'c' }])

		const count = await store.finalize('memory')
		const parsed = JSON.parse(
			await readFile(join(store.runDir, 'memory.json'), 'utf8')
		)

		assert.equal(count, 3)
		assert.deepEqual(parsed.map((p: any) => p.name), ['a', 'b', 'c'])
	})

	it('writes a valid empty array for an endpoint that produced nothing', async () => {
		const store = await SnapshotStore.open(dir, null)
		assert.equal(await store.finalize('ups'), 0)
		assert.deepEqual(
			JSON.parse(await readFile(join(store.runDir, 'ups.json'), 'utf8')),
			[]
		)
	})
})

describe('proxyServerArg', () => {
	it('strips credentials, which Chromium refuses in --proxy-server', () => {
		assert.equal(
			proxyServerArg('http://user:pass@proxy.example:8080'),
			'http://proxy.example:8080'
		)
	})

	it('leaves a credential-free proxy alone', () => {
		assert.equal(
			proxyServerArg('http://proxy.example:8080'),
			'http://proxy.example:8080'
		)
	})

	it('passes through a bare host:port', () => {
		assert.equal(proxyServerArg('proxy.example:8080'), 'proxy.example:8080')
	})
})

describe('parseArgs value splitting', () => {
	it('keeps everything after the first = in the value', () => {
		// `'--proxy=http://u:p==@h:1'.split('=', 2)` truncates the password.
		const config = parseArgs(['--proxy=http://u:p==w@h:8080'], {})
		assert.equal(config.proxy, 'http://u:p==w@h:8080')
	})

	it('treats a bare flag as true', () => {
		assert.equal(parseArgs(['--fail-on-drift'], {}).failOnDrift, true)
	})
})

describe('NaN never reaches the output', () => {
	it('nulls a NaN from the generic numeric path and warns', () => {
		const drift = new DriftCollector()
		// serializeNumber('N/A.') matches a lone '.', and parseFloat('.') is NaN.
		const { part, warnings } = normalize(
			'memory',
			raw({ specs: [{ label: 'CAS Latency', value: 'N/A.' }] }),
			drift
		)

		assert.equal(part['cas_latency'], null)
		assert.ok(warnings.some((w) => w.includes('NaN')))
	})

	it('nulls a NaN price and warns', () => {
		const drift = new DriftCollector()
		const { part, warnings } = normalize('memory', raw({ priceText: '$.' }), drift)

		assert.equal(part['price'], null)
		assert.ok(warnings.some((w) => w.includes('NaN')))
	})
})

describe('outputCsv array quoting', () => {
	it('quotes an array once, not once per element', () => {
		// Double-quoting produced `"""a, b"",c"`, which no parser can read.
		const csv = outputCsv([{ tags: ['a, b', 'c'] }])
		assert.equal(csv.trim().split('\n')[1], '"a, b,c"')
	})

	it('escapes quotes inside array elements exactly once', () => {
		const csv = outputCsv([{ tags: ['say "hi"', 'x'] }])
		assert.equal(csv.trim().split('\n')[1], '"say ""hi"",x"')
	})

	it('still renders a numeric array as before', () => {
		assert.equal(outputCsv([{ speed: [5, 6000] }]).trim().split('\n')[1], '"5,6000"')
	})
})
