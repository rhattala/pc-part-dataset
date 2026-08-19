import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import type { Part } from './types'

/** Bookkeeping files a run directory contains alongside the part data. */
const NON_PART_FILES = new Set(['report.json', 'checkpoint.json'])

async function main() {
	const dirName = process.argv.slice(2)[0] ?? 'data-staging/latest'

	const entries = await readdir(dirName, { withFileTypes: true })
	const hasJsonSubdir = entries.some(
		(e) => e.isDirectory() && e.name === 'json'
	)
	const sourceDir = hasJsonSubdir ? join(dirName, 'json') : dirName
	const files = hasJsonSubdir
		? await readdir(sourceDir)
		: entries.map((e) => e.name)

	let count = 0

	for (const file of files) {
		if (!file.endsWith('.json')) continue
		if (NON_PART_FILES.has(file)) continue

		const raw = await readFile(join(sourceDir, file), 'utf8')
		const json: Part[] = JSON.parse(raw)

		count += json.length
	}

	console.log(count)
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
