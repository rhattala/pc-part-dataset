import type { PartType } from '../types'

/**
 * Overridable so the scraper can be pointed at a local fixture server in
 * tests, or at a mirror. Defaults to the real site.
 */
export const BASE_URL =
	process.env['SCRAPER_BASE_URL'] ?? 'https://pcpartpicker.com/products'
export const ORIGIN = new URL(BASE_URL).origin

export const ALL_ENDPOINTS: PartType[] = [
	'cpu',
	'cpu-cooler',
	'motherboard',
	'memory',
	'internal-hard-drive',
	'video-card',
	'case',
	'power-supply',
	'os',
	'monitor',
	'sound-card',
	'wired-network-card',
	'wireless-network-card',
	'headphones',
	'keyboard',
	'mouse',
	'speakers',
	'webcam',
	'case-accessory',
	'case-fan',
	'fan-controller',
	'thermal-paste',
	'external-hard-drive',
	'optical-drive',
	'ups',
]

export interface Config {
	endpoints: PartType[]
	outDir: string
	/** Parallel browser tabs. PCPartPicker is rate-sensitive; keep this low. */
	concurrency: number
	/** Base delay between page navigations, in ms. Jitter is added on top. */
	delayMs: number
	/** Random extra delay, 0..jitterMs, added to every navigation. */
	jitterMs: number
	/** Attempts per page before the page is given up on. */
	retries: number
	navTimeoutMs: number
	headless: boolean
	/** `http://user:pass@host:port` — required from datacenter IPs. */
	proxy: string | null
	/** Resume a previous run id instead of starting a fresh one. */
	resume: string | null
	/** Stop after N pages per endpoint. For smoke tests. */
	maxPages: number | null
	/** Exit non-zero if any unmapped spec label is seen. For CI drift alarms. */
	failOnDrift: boolean
	sandbox: boolean
}

const num = (v: string | undefined, fallback: number) => {
	if (v == null || v.trim() === '') return fallback
	const n = Number(v)
	return Number.isFinite(n) ? n : fallback
}

const bool = (v: string | undefined, fallback: boolean) => {
	if (v == null || v.trim() === '') return fallback
	return !['0', 'false', 'no', 'off'].includes(v.toLowerCase())
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Config {
	const flags = new Map<string, string>()
	const positional: string[] = []

	for (const arg of argv) {
		if (arg.startsWith('--')) {
			const [key, value] = arg.slice(2).split('=', 2)
			flags.set(key!, value ?? 'true')
		} else {
			positional.push(arg)
		}
	}

	const unknown = positional.filter(
		(p) => !ALL_ENDPOINTS.includes(p as PartType)
	)
	if (unknown.length) {
		throw new Error(
			`Unknown endpoint(s): ${unknown.join(', ')}\n` +
				`Valid endpoints: ${ALL_ENDPOINTS.join(', ')}`
		)
	}

	return {
		endpoints: positional.length ? (positional as PartType[]) : ALL_ENDPOINTS,
		outDir: flags.get('out') ?? env['SCRAPER_OUT'] ?? 'data-staging',
		concurrency: num(
			flags.get('concurrency') ?? env['SCRAPER_CONCURRENCY'],
			3
		),
		delayMs: num(flags.get('delay') ?? env['SCRAPER_DELAY_MS'], 1200),
		jitterMs: num(flags.get('jitter') ?? env['SCRAPER_JITTER_MS'], 800),
		retries: num(flags.get('retries') ?? env['SCRAPER_RETRIES'], 3),
		navTimeoutMs: num(flags.get('timeout') ?? env['SCRAPER_TIMEOUT_MS'], 45_000),
		headless: bool(flags.get('headless') ?? env['SCRAPER_HEADLESS'], true),
		proxy: flags.get('proxy') ?? env['SCRAPER_PROXY'] ?? null,
		resume: flags.get('resume') ?? null,
		maxPages: flags.has('max-pages')
			? num(flags.get('max-pages'), 1)
			: env['SCRAPER_MAX_PAGES']
				? num(env['SCRAPER_MAX_PAGES'], 1)
				: null,
		failOnDrift: bool(flags.get('fail-on-drift'), false),
		sandbox: bool(flags.get('sandbox') ?? env['SCRAPER_SANDBOX'], true),
	}
}

export const USAGE = `
Usage: npm run scrape -- [endpoints...] [flags]

  Scrapes PCPartPicker product tables into timestamped JSON snapshots.
  With no endpoints, every category is scraped.

Flags
  --out=DIR            Output directory              (default: data-staging)
  --concurrency=N      Parallel tabs                 (default: 3)
  --delay=MS           Base delay between navigations(default: 1200)
  --jitter=MS          Random extra delay 0..MS      (default: 800)
  --retries=N          Attempts per page             (default: 3)
  --timeout=MS         Navigation timeout            (default: 45000)
  --headless=false     Show the browser
  --proxy=URL          http://user:pass@host:port
  --resume=RUN_ID      Continue a previous run, skipping finished pages
  --max-pages=N        Stop after N pages per endpoint (smoke test)
  --fail-on-drift      Exit non-zero if an unmapped spec label appears
  --sandbox=false      Pass --no-sandbox (needed as root / in containers)

Environment
  SCRAPER_PROXY, SCRAPER_CONCURRENCY, SCRAPER_DELAY_MS, SCRAPER_JITTER_MS,
  SCRAPER_RETRIES, SCRAPER_TIMEOUT_MS, SCRAPER_HEADLESS, SCRAPER_OUT,
  SCRAPER_MAX_PAGES, SCRAPER_SANDBOX

Note
  PCPartPicker is behind Cloudflare and refuses datacenter IPs. Use
  --proxy with a residential endpoint, or run from a residential
  connection. Run \`npm run probe\` first to check reachability.
`
