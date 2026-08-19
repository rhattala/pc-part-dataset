import type { Browser, Page } from 'puppeteer' with { 'resolution-mode': 'import' }
import type { EndpointReport, Part, PartType } from '../types'
import {
	detectChallenge,
	explainNavigationError,
	preparePage,
} from './browser'
import { BASE_URL, type Config } from './config'
import { extractProducts, readPageCount, ROW_SELECTOR } from './extract'
import { log, politeDelay, withRetry } from './log'
import { DriftCollector, normalize } from './normalize'
import type { SnapshotStore } from './store'
import { validatePart } from './validate'

/** Product id of the first row, used to confirm a page turn actually landed. */
async function firstRowId(page: Page): Promise<string | null> {
	return page
		.$eval(ROW_SELECTOR, (row) => {
			const href = row
				.querySelector('.td__name a[href]')
				?.getAttribute('href')
			return href ?? (row.textContent ?? '').slice(0, 80)
		})
		.catch(() => null)
}

/**
 * PCPartPicker paginates client-side off the URL hash. Rather than trusting
 * `waitForNetworkIdle` (which returns as soon as the network is quiet, not
 * when the table has actually re-rendered), we remember the first row and
 * wait for it to change. If the hash route does not take, we fall back to a
 * hard navigation.
 */
async function gotoPage(page: Page, endpoint: PartType, pageNumber: number) {
	const url = `${BASE_URL}/${endpoint}/`

	if (pageNumber === 1) {
		await page.goto(url, { waitUntil: 'domcontentloaded' })
		await page.waitForSelector(ROW_SELECTOR)
		return
	}

	const before = await firstRowId(page)

	await page.evaluate((n) => {
		window.location.hash = `#page=${n}`
	}, pageNumber)

	try {
		await page.waitForFunction(
			(selector, previous) => {
				const row = document.querySelector(selector)
				if (!row) return false
				const href = row
					.querySelector('.td__name a[href]')
					?.getAttribute('href')
				const current = href ?? (row.textContent ?? '').slice(0, 80)
				return current !== previous
			},
			{ polling: 250 },
			ROW_SELECTOR,
			before
		)
	} catch {
		// Hash routing did not re-render in time — force a real navigation.
		await page.goto(`${url}#page=${pageNumber}`, {
			waitUntil: 'networkidle2',
		})
		await page.waitForSelector(ROW_SELECTOR)
	}
}

export async function scrapeEndpoint(
	browser: Browser,
	endpoint: PartType,
	config: Config,
	store: SnapshotStore,
	drift: DriftCollector,
	donePages: Set<number>
): Promise<EndpointReport> {
	const startedAt = Date.now()
	const report: EndpointReport = {
		endpoint,
		status: 'ok',
		pagesExpected: null,
		pagesScraped: 0,
		rows: 0,
		rowsInvalid: 0,
		missingMappedLabels: [],
		drift: [],
		errors: [],
		durationMs: 0,
	}

	// Everything below runs inside the try, including opening the tab: this
	// function is called from a pool, and anything thrown out of it would
	// take the other endpoints' results down with it.
	let page: Page | null = null

	try {
		page = await browser.newPage()
		// Narrowed alias: `page` is a mutable binding, so TypeScript cannot
		// keep it non-null inside the closures below.
		const tab = page
		await preparePage(tab, config)

		const first = await withRetry(`${endpoint} page 1`, config.retries, async () => {
			await gotoPage(tab, endpoint, 1)
			return readPageCount(tab)
		})

		if (!first.ok) {
			report.status = 'failed'

			const challenge = await detectChallenge(tab)
			const network = explainNavigationError(
				first.error.message,
				config.proxy != null
			)

			if (challenge)
				report.errors.push(
					`${challenge} — PCPartPicker is not serving this IP. ` +
						`Retry with --proxy=<residential endpoint>.`
				)
			else if (network)
				report.errors.push(`${first.error.message} — ${network}`)
			else
				report.errors.push(
					`could not load first page: ${first.error.message}`
				)

			return report
		}

		// A missing pagination widget means a single-page category, not an error.
		const totalPages = first.value ?? 1
		report.pagesExpected = totalPages

		const limit = config.maxPages
			? Math.min(totalPages, config.maxPages)
			: totalPages

		log.info(`[${endpoint}] ${totalPages} page(s); scraping ${limit}`)

		for (let pageNumber = 1; pageNumber <= limit; pageNumber++) {
			if (donePages.has(pageNumber)) {
				report.pagesScraped++
				continue
			}

			const attempt = await withRetry(
				`${endpoint} page ${pageNumber}`,
				config.retries,
				async (n) => {
					// On a retry the tab may be anywhere; page 1 is the only
					// position we can re-establish cheaply and reliably.
					if (n > 1) await gotoPage(tab, endpoint, 1)
					if (pageNumber > 1) await gotoPage(tab, endpoint, pageNumber)
					return extractProducts(tab)
				}
			)

			if (!attempt.ok) {
				report.status = 'partial'
				report.errors.push(
					`page ${pageNumber}: ${attempt.error.message}`
				)
				continue
			}

			const parts: Part[] = []

			for (const raw of attempt.value) {
				const { part, warnings } = normalize(endpoint, raw, drift)
				for (const warning of warnings) {
					if (report.errors.length < 50) report.errors.push(warning)
				}

				const validation = validatePart(part)
				if (!validation.ok) {
					report.rowsInvalid++
					if (report.errors.length < 50)
						report.errors.push(
							`page ${pageNumber}: invalid row (${validation.reason})`
						)
				}

				parts.push(part)
			}

			await store.appendPage(endpoint, pageNumber, parts)
			report.rows += parts.length
			report.pagesScraped++

			if (pageNumber % 25 === 0 || pageNumber === limit)
				log.info(
					`[${endpoint}] page ${pageNumber}/${limit} — ${report.rows} rows`
				)

			if (pageNumber < limit)
				await politeDelay(config.delayMs, config.jitterMs)
		}

		if (report.pagesScraped < limit && report.status === 'ok')
			report.status = 'partial'
	} catch (error) {
		report.status = 'failed'
		report.errors.push(String(error))
	} finally {
		report.drift = drift.forEndpoint(endpoint)
		report.missingMappedLabels = drift.missingFor(endpoint)
		report.durationMs = Date.now() - startedAt
		await page?.close().catch(() => {})
	}

	return report
}
