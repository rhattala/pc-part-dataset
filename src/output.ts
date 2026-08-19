import { mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { Part } from './types'

/** Bookkeeping files a run directory contains alongside the part data. */
const NON_PART_FILES = new Set(['report.json', 'checkpoint.json'])

export const outputJsonLines = (parts: Part[]) =>
	parts.map((p) => JSON.stringify(p)).join('\n')

const serializeCsvValue = (value: any): string => {
	if (value == null) return ''

	if (Array.isArray(value))
		return `"${value.map((v) => serializeCsvValue(v)).join(',')}"`

	const str = String(value)

	if (str.includes(',') || str.includes('"') || str.includes('\n'))
		return `"${str.replaceAll('"', '""')}"`

	return str
}

export const outputCsv = (parts: Part[]) => {
	if (!parts.length) return ''

	// Union of every row's keys, in first-seen order. Taking the header from
	// `parts[0]` alone (and then writing `Object.values(part)` positionally)
	// silently shifted every column whenever a row had a different key set —
	// which happens routinely now that unmapped specs are preserved rather
	// than throwing.
	const keys: string[] = []
	const seen = new Set<string>()

	for (const part of parts) {
		for (const key of Object.keys(part)) {
			if (seen.has(key)) continue
			seen.add(key)
			keys.push(key)
		}
	}

	const rows = parts.map((part) =>
		keys.map((key) => serializeCsvValue(part[key])).join(',')
	)

	return [keys.join(','), ...rows].join('\n') + '\n'
}

async function main() {
	// Defaults to whatever `npm run scrape` last produced.
	const dirName = process.argv.slice(2)[0] ?? 'data-staging/latest'

	// Support both the run-directory layout (`<dir>/cpu.json`) and the older
	// `<dir>/json/cpu.json` layout that `./data` still uses.
	const entries = await readdir(dirName, { withFileTypes: true })
	const hasJsonSubdir = entries.some(
		(e) => e.isDirectory() && e.name === 'json'
	)
	const sourceDir = hasJsonSubdir ? join(dirName, 'json') : dirName
	const files = hasJsonSubdir ? await readdir(sourceDir) : entries.map((e) => e.name)

	await mkdir(join(dirName, 'csv'), { recursive: true })
	await mkdir(join(dirName, 'jsonl'), { recursive: true })

	for (const file of files) {
		if (!file.endsWith('.json')) continue
		if (NON_PART_FILES.has(file)) continue

		const raw = await readFile(join(sourceDir, file), 'utf8')
		const parts: Part[] = JSON.parse(raw)

		await writeFile(
			join(dirName, 'jsonl', file.replace('.json', '.jsonl')),
			outputJsonLines(parts)
		)

		await writeFile(
			join(dirName, 'csv', file.replace('.json', '.csv')),
			outputCsv(parts)
		)
	}
}

if (require.main === module) {
	main().catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
}
