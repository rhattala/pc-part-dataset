import type { Page } from 'puppeteer' with { 'resolution-mode': 'import' }
import type { RawProduct } from '../types'

export const ROW_SELECTOR = '.tr__product'
export const PAGINATION_SELECTOR = '.pagination'

/**
 * Pulls every product row out of the current page in a *single* round-trip.
 *
 * The legacy scraper issued one `$eval` per spec per product — for the memory
 * category that is ~13.5k rows x 6 specs x 2 evals, i.e. six figures of
 * CDP round-trips per run. Serializing one function into the page and
 * returning a plain array collapses that to one call per page.
 *
 * This function body is stringified and executed in the browser, so it may
 * not close over anything from module scope.
 */
export async function extractProducts(page: Page): Promise<RawProduct[]> {
	return page.$$eval(ROW_SELECTOR, (rows) => {
		const text = (el: Element | null | undefined) =>
			el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() : null

		return rows.map((row) => {
			const nameEl =
				row.querySelector('.td__name .td__nameWrapper > p') ??
				row.querySelector('.td__nameWrapper > p') ??
				row.querySelector('.td__name p') ??
				row.querySelector('.td__name')

			const anchor = row.querySelector<HTMLAnchorElement>(
				'.td__name a[href]'
			)
			const path = anchor?.getAttribute('href') ?? null

			// `/product/9nm323/slug` -> `9nm323`
			const idMatch = path?.match(/\/product\/([^/?#]+)/)

			const specs: Array<{ label: string; value: string | null }> = []

			for (const cell of Array.from(row.querySelectorAll('td.td__spec'))) {
				const labelEl = cell.querySelector('.specLabel')
				const label = labelEl
					? (labelEl.textContent ?? '').replace(/\s+/g, ' ').trim()
					: ''
				if (!label) continue

				// Take everything in the cell that is not the label. Cloning
				// avoids relying on `childNodes[1]`, which breaks the moment
				// PCPartPicker adds a wrapper element or a stray text node.
				const clone = cell.cloneNode(true) as HTMLElement
				clone.querySelector('.specLabel')?.remove()
				const value = (clone.textContent ?? '').replace(/\s+/g, ' ').trim()

				specs.push({ label, value: value === '' ? null : value })
			}

			return {
				name: text(nameEl),
				path,
				id: idMatch?.[1] ?? null,
				priceText: text(row.querySelector('.td__price')),
				ratingText: text(row.querySelector('.td__rating')),
				specs,
			}
		})
	})
}

/**
 * Reads the highest page number out of the pagination widget.
 * Returns null when the widget is absent, which for PCPartPicker means the
 * category fits on a single page (`os`, `fan-controller`, ...).
 */
export async function readPageCount(page: Page): Promise<number | null> {
	const el = await page.$(PAGINATION_SELECTOR)
	if (!el) return null

	const count = await el.evaluate((node) => {
		const numbers = Array.from(node.querySelectorAll('li'))
			.map((li) => parseInt((li.textContent ?? '').trim(), 10))
			.filter((n) => Number.isFinite(n))

		return numbers.length ? Math.max(...numbers) : null
	})

	await el.dispose()
	return count
}
