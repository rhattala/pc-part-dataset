import type { Browser, Page } from 'puppeteer' with { 'resolution-mode': 'import' }
import type { Config } from './config'
import { log } from './log'

/**
 * A recent, real Chrome UA. Puppeteer's default advertises HeadlessChrome,
 * which Cloudflare buckets immediately.
 */
export const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

/**
 * `puppeteer-extra-plugin-stealth` is an optionalDependency and is no longer
 * actively maintained, so it is loaded defensively: if it is missing or
 * incompatible with the installed puppeteer, we fall back to vanilla
 * puppeteer with manual hardening rather than failing to start.
 *
 * Note that stealth alone will NOT get you past PCPartPicker's Cloudflare
 * challenge from a datacenter IP. The IP is the signal that matters; use
 * `--proxy` with a residential endpoint.
 */
async function loadPuppeteer() {
	try {
		const extra = (await import('puppeteer-extra')).default as any
		const stealth = (await import('puppeteer-extra-plugin-stealth')).default
		extra.use(stealth())
		return { puppeteer: extra, stealth: true }
	} catch (error) {
		log.warn(`stealth plugin unavailable (${error}); using vanilla puppeteer`)
		const vanilla = (await import('puppeteer')).default as any
		return { puppeteer: vanilla, stealth: false }
	}
}

/**
 * Chromium's `--proxy-server` does not accept embedded credentials — given
 * `http://user:pass@host:port` it fails to connect entirely. Strip them here;
 * `preparePage` supplies them through `page.authenticate` instead, which is
 * the mechanism Chromium actually supports.
 */
export function proxyServerArg(proxy: string): string {
	try {
		const parsed = new URL(proxy)
		parsed.username = ''
		parsed.password = ''
		// `URL` renders a trailing slash that Chromium does not want.
		return parsed.toString().replace(/\/$/, '')
	} catch {
		// Not URL-shaped (e.g. a bare `host:port`); pass it through untouched.
		return proxy
	}
}

export async function launch(config: Config): Promise<Browser> {
	const { puppeteer, stealth } = await loadPuppeteer()

	const args = [
		'--disable-blink-features=AutomationControlled',
		'--disable-dev-shm-usage',
		'--window-size=1920,1080',
	]

	if (!config.sandbox) args.push('--no-sandbox', '--disable-setuid-sandbox')
	if (config.proxy) args.push(`--proxy-server=${proxyServerArg(config.proxy)}`)

	log.info(
		`launching chrome (headless=${config.headless} stealth=${stealth} ` +
			`proxy=${config.proxy ? 'yes' : 'no'} sandbox=${config.sandbox})`
	)

	return puppeteer.launch({
		headless: config.headless,
		args,
		defaultViewport: { width: 1920, height: 1080 },
	})
}

/** Applies the per-page setup every scraper page needs. */
export async function preparePage(page: Page, config: Config): Promise<void> {
	page.setDefaultNavigationTimeout(config.navTimeoutMs)
	page.setDefaultTimeout(config.navTimeoutMs)

	await page.setUserAgent(USER_AGENT)
	await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })

	if (config.proxy) {
		const parsed = new URL(config.proxy)
		if (parsed.username) {
			await page.authenticate({
				username: decodeURIComponent(parsed.username),
				password: decodeURIComponent(parsed.password),
			})
		}
	}

	// Skip assets we never read. Cuts bandwidth and page time substantially,
	// and there is nothing in a font or a product thumbnail that we parse.
	await page.setRequestInterception(true)
	page.on('request', (req) => {
		if (req.isInterceptResolutionHandled()) return

		switch (req.resourceType()) {
			case 'font':
			case 'image':
			case 'media':
			case 'stylesheet':
				req.abort().catch(() => {})
				break
			default:
				req.continue().catch(() => {})
		}
	})
}

/**
 * Turns Chromium's terse `net::` codes into something that says what to do.
 * Getting blocked by Cloudflare, being unable to reach the network at all,
 * and having a broken proxy all look identical in a raw stack trace, and
 * they need completely different fixes.
 */
export function explainNavigationError(
	message: string,
	hasProxy: boolean
): string | null {
	if (/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED/.test(message))
		return 'the proxy itself refused the connection — check --proxy host, port and credentials'

	if (/ERR_NAME_NOT_RESOLVED/.test(message))
		return 'DNS lookup failed — no working resolver in this environment'

	if (
		/ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_TIMED_OUT/.test(
			message
		)
	)
		return hasProxy
			? 'the connection was dropped before any page was served — the proxy may not allow this host'
			: 'the connection was dropped before any page was served. This is network egress, ' +
					'not a bot block: Chromium reached nothing. If you are in a container or CI, ' +
					'route it with --proxy=http://host:port'

	return null
}

/**
 * Cloudflare's interstitial. Detecting it explicitly turns the confusing
 * "no .pagination found" timeout into an actionable message.
 */
/**
 * Chromium's built-in network error page. It has to be distinguished from a
 * real response: the selectors all legitimately miss on it, which otherwise
 * reads as "PCPartPicker changed its markup" when in fact nothing loaded.
 */
export function isChromeErrorPage(html: string, url: string): boolean {
	if (url === 'about:blank') return true
	return (
		/id="?main-frame-error/.test(html) ||
		/jstcache=/.test(html) ||
		/chrome-error:\/\//.test(url)
	)
}

export async function detectChallenge(page: Page): Promise<string | null> {
	const html = await page.content().catch(() => '')
	const title = await page.title().catch(() => '')

	if (/just a moment|attention required|checking your browser/i.test(title))
		return `Cloudflare challenge (page title: ${JSON.stringify(title)})`

	if (/__cf_chl|cf-challenge|challenges\.cloudflare\.com/i.test(html))
		return 'Cloudflare challenge (challenge script present in HTML)'

	return null
}
