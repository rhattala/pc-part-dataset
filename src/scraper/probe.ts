import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import untypedMap from '../serialization-map.json'
import type { PartType, SerializationMap } from '../types'
import { detectChallenge, launch, preparePage } from './browser'
import { BASE_URL, parseArgs } from './config'
import { extractProducts, readPageCount, ROW_SELECTOR } from './extract'
import { log, politeDelay } from './log'
import { DriftCollector, normalize } from './normalize'

const map = untypedMap as unknown as SerializationMap

/**
 * Answers "what does PCPartPicker actually look like right now?" without
 * scraping anything.
 *
 * Run this first, from an IP PCPartPicker will serve. It reports whether the
 * page loads at all, whether every selector the scraper depends on still
 * matches, which spec labels the category renders today versus what
 * `serialization-map.json` expects, and every XHR the page issues while
 * paginating — the last of which is how you find out whether there is a JSON
 * endpoint worth using instead of the DOM.
 */

interface SeenRequest {
	url: string
	resourceType: string
	status: number | null
	contentType: string | null
}

const SELECTORS = [
	ROW_SELECTOR,
	'.pagination',
	'.td__name',
	'.td__name .td__nameWrapper > p',
	'.td__name a[href]',
	'.td__spec',
	'.specLabel',
	'.td__price',
	'.td__rating',
]

async function main() {
	const argv = process.argv.slice(2)
	const config = parseArgs(
		argv.length ? argv : ['cpu'],
		process.env
	)
	const endpoint = config.endpoints[0]!
	const outDir = join(config.outDir, 'probe')
	await mkdir(outDir, { recursive: true })

	const browser = await launch(config)
	const page = await browser.newPage()
	const requests: SeenRequest[] = []

	const lines: string[] = []
	const say = (message: string) => {
		lines.push(message)
		console.log(message)
	}

	try {
		await preparePage(page, config)

		page.on('response', (res) => {
			const req = res.request()
			const type = req.resourceType()
			if (type !== 'xhr' && type !== 'fetch' && type !== 'document') return
			requests.push({
				url: res.url(),
				resourceType: type,
				status: res.status(),
				contentType: res.headers()['content-type'] ?? null,
			})
		})

		const url = `${BASE_URL}/${endpoint}/`
		say(`# PCPartPicker probe — ${endpoint}`)
		say(`url: ${url}`)

		const response = await page
			.goto(url, { waitUntil: 'domcontentloaded' })
			.catch((error) => {
				say(`NAVIGATION FAILED: ${error.message}`)
				return null
			})

		say(`http status: ${response?.status() ?? 'n/a'}`)
		say(`final url:   ${page.url()}`)
		say(`title:       ${JSON.stringify(await page.title().catch(() => ''))}`)

		const challenge = await detectChallenge(page)
		say(`challenge:   ${challenge ?? 'none detected'}`)

		const html = await page.content().catch(() => '')
		await writeFile(join(outDir, `${endpoint}-page1.html`), html, 'utf8')
		say(`html saved:  ${join(outDir, `${endpoint}-page1.html`)} (${html.length} bytes)`)

		if (challenge) {
			say('')
			say('Blocked before any markup was served. Nothing below is meaningful.')
			say('Retry from a residential connection, or with --proxy=http://user:pass@host:port')
			return
		}

		// --- selector health -------------------------------------------------
		say('')
		say('## selectors')
		for (const selector of SELECTORS) {
			const count = await page
				.$$eval(selector, (els) => els.length)
				.catch(() => -1)
			const flag = count > 0 ? 'ok  ' : 'MISS'
			say(`${flag} ${String(count).padStart(5)}  ${selector}`)
		}

		const pageCount = await readPageCount(page).catch(() => null)
		say(`pagination reports: ${pageCount ?? 'no pagination widget'} page(s)`)

		// --- spec labels vs the map -----------------------------------------
		const rows = await extractProducts(page).catch((error) => {
			say(`extraction threw: ${error}`)
			return []
		})

		say('')
		say(`## rows on page 1: ${rows.length}`)

		const observed = new Set<string>()
		for (const row of rows) for (const s of row.specs) observed.add(s.label)

		const expected = new Set(Object.keys(map[endpoint] ?? {}))
		const unmapped = [...observed].filter((l) => !expected.has(l))
		const vanished = [...expected].filter((l) => !observed.has(l))

		say('')
		say('## spec labels')
		say(`observed (${observed.size}): ${[...observed].join(' | ') || '(none)'}`)
		say(`unmapped (${unmapped.length}): ${unmapped.join(' | ') || '(none)'}`)
		say(`in map but absent (${vanished.length}): ${vanished.join(' | ') || '(none)'}`)

		// --- identity coverage ----------------------------------------------
		const withId = rows.filter((r) => r.id).length
		const withName = rows.filter((r) => r.name).length
		const withPrice = rows.filter((r) => r.priceText).length
		say('')
		say('## field coverage on page 1')
		say(`name:  ${withName}/${rows.length}`)
		say(`id:    ${withId}/${rows.length}   (product url parsed)`)
		say(`price: ${withPrice}/${rows.length}`)

		// --- sample normalized rows -----------------------------------------
		const drift = new DriftCollector()
		say('')
		say('## sample normalized rows')
		for (const raw of rows.slice(0, 3))
			say(JSON.stringify(normalize(endpoint as PartType, raw, drift).part))

		// --- what happens when we paginate ----------------------------------
		if ((pageCount ?? 1) > 1) {
			const before = requests.length
			await politeDelay(config.delayMs, config.jitterMs)
			await page.evaluate(() => {
				window.location.hash = '#page=2'
			})
			await page
				.waitForNetworkIdle({ idleTime: 1500, timeout: 15_000 })
				.catch(() => {})

			say('')
			say('## network while paginating to page 2')
			const during = requests.slice(before)
			if (!during.length) say('(no xhr/fetch observed — pagination may be client-side only)')
			for (const req of during)
				say(`${req.status} ${req.resourceType.padEnd(9)} ${req.contentType ?? '-'}\n     ${req.url}`)

			const json = during.filter((r) => r.contentType?.includes('json'))
			if (json.length) {
				say('')
				say('JSON ENDPOINT(S) FOUND — these are likely a better scrape target')
				say('than the DOM: stable shape, no selectors, far fewer requests.')
				for (const r of json) say(`  ${r.url}`)
			}
		}

		say('')
		say('## all document/xhr/fetch responses seen')
		for (const req of requests)
			say(`${req.status} ${req.resourceType.padEnd(9)} ${req.url}`)
	} finally {
		await writeFile(join(outDir, `${endpoint}-probe.md`), lines.join('\n'), 'utf8')
		log.info(`probe report: ${join(outDir, `${endpoint}-probe.md`)}`)
		await browser.close().catch(() => {})
	}
}

main().catch((error) => {
	log.error(String(error?.stack ?? error))
	process.exitCode = 1
})
