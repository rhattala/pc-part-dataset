import type { EndpointReport, RunReport } from '../types'
import { launch } from './browser'
import { parseArgs, BASE_URL, USAGE } from './config'
import { log, pool } from './log'
import { DriftCollector } from './normalize'
import { scrapeEndpoint } from './scrape'
import { SnapshotStore } from './store'

async function main() {
	const argv = process.argv.slice(2)

	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(USAGE)
		return 0
	}

	const config = parseArgs(argv, process.env)
	const store = await SnapshotStore.open(config.outDir, config.resume)
	const checkpoint = store.readCheckpoint()

	if (config.resume)
		log.info(
			`resuming run ${store.runId} — ` +
				`${Object.values(checkpoint).flat().length} page(s) already done`
		)

	log.info(`run ${store.runId} -> ${store.runDir}`)
	log.info(`endpoints: ${config.endpoints.join(', ')}`)

	const startedAt = new Date().toISOString()
	const browser = await launch(config)
	const drift = new DriftCollector()

	let reports: EndpointReport[] = []

	try {
		reports = await pool(config.endpoints, config.concurrency, (endpoint) =>
			scrapeEndpoint(
				browser,
				endpoint,
				config,
				store,
				drift,
				new Set(checkpoint[endpoint] ?? [])
			)
		)
	} finally {
		await browser.close().catch(() => {})
	}

	for (const report of reports) {
		const finalized = await store.finalize(report.endpoint)
		if (finalized !== report.rows)
			// Differs on a resumed run, where earlier pages are on disk but not
			// counted in this process's totals.
			report.rows = finalized
	}

	const runReport: RunReport = {
		runId: store.runId,
		startedAt,
		finishedAt: new Date().toISOString(),
		baseUrl: BASE_URL,
		endpoints: reports,
		totals: {
			rows: reports.reduce((n, r) => n + r.rows, 0),
			rowsInvalid: reports.reduce((n, r) => n + r.rowsInvalid, 0),
			endpointsOk: reports.filter((r) => r.status === 'ok').length,
			endpointsPartial: reports.filter((r) => r.status === 'partial').length,
			endpointsFailed: reports.filter((r) => r.status === 'failed').length,
			driftLabels: drift.size,
		},
	}

	await store.writeReport(runReport)
	await store.linkLatest()

	summarize(runReport)

	if (runReport.totals.endpointsFailed === config.endpoints.length) return 1
	if (config.failOnDrift && runReport.totals.driftLabels > 0) return 2
	if (runReport.totals.endpointsFailed > 0) return 3
	return 0
}

function summarize(report: RunReport) {
	const { totals } = report

	console.log('\n' + '='.repeat(64))
	console.log(`run ${report.runId}`)
	console.log('='.repeat(64))

	for (const endpoint of report.endpoints) {
		const flag =
			endpoint.status === 'ok'
				? 'ok  '
				: endpoint.status === 'partial'
					? 'PART'
					: 'FAIL'

		console.log(
			`${flag} ${endpoint.endpoint.padEnd(22)} ` +
				`${String(endpoint.rows).padStart(7)} rows  ` +
				`${endpoint.pagesScraped}/${endpoint.pagesExpected ?? '?'} pages  ` +
				`${(endpoint.durationMs / 1000).toFixed(1)}s`
		)

		for (const error of endpoint.errors.slice(0, 3))
			console.log(`       ! ${error}`)
	}

	console.log('-'.repeat(64))
	console.log(
		`${totals.rows} rows  |  ${totals.rowsInvalid} invalid  |  ` +
			`${totals.endpointsOk} ok / ${totals.endpointsPartial} partial / ` +
			`${totals.endpointsFailed} failed`
	)

	const allDrift = report.endpoints.flatMap((e) => e.drift)
	if (allDrift.length) {
		console.log(
			`\nUNMAPPED SPEC LABELS (${allDrift.length}) — add these to ` +
				`src/serialization-map.json:`
		)
		for (const d of allDrift)
			console.log(
				`  ${d.endpoint.padEnd(22)} ${JSON.stringify(d.label).padEnd(28)} ` +
					`x${d.count}  e.g. ${JSON.stringify(d.sampleValue)}`
			)
	}

	const missing = report.endpoints.filter((e) => e.missingMappedLabels.length)
	if (missing.length) {
		console.log('\nMAPPED LABELS THAT NEVER APPEARED (column removed?):')
		for (const e of missing)
			console.log(`  ${e.endpoint.padEnd(22)} ${e.missingMappedLabels.join(', ')}`)
	}

	console.log(`\nreport: ${report.runId}/report.json`)
}

main()
	.then((code) => {
		process.exitCode = code
	})
	.catch((error) => {
		log.error(String(error?.stack ?? error))
		process.exitCode = 1
	})
