import { createReadStream, createWriteStream } from 'fs'
import { appendFile, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises'
import { createInterface } from 'readline'
import { dirname, join, resolve } from 'path'
import type { Part, PartType, RunReport } from '../types'

/**
 * Snapshot layout:
 *
 *   <outDir>/runs/<runId>/<endpoint>.jsonl   append-only, written per page
 *   <outDir>/runs/<runId>/<endpoint>.json    finalized array
 *   <outDir>/runs/<runId>/checkpoint.json    pages already durably written
 *   <outDir>/runs/<runId>/report.json        run report
 *   <outDir>/latest                          symlink -> runs/<runId>
 *
 * Writing JSONL as we go is what makes `--resume` possible. The legacy
 * scraper buffered every row for a category in memory and wrote once at the
 * very end, so any failure at page 400 of 450 threw away the whole category.
 */
export class SnapshotStore {
	readonly runId: string
	readonly runDir: string

	private constructor(
		private readonly outDir: string,
		runId: string
	) {
		this.runId = runId
		this.runDir = join(outDir, 'runs', runId)
	}

	static async open(outDir: string, resume: string | null) {
		const runId = resume ?? new Date().toISOString().replace(/[:.]/g, '-')
		const store = new SnapshotStore(outDir, runId)
		await mkdir(store.runDir, { recursive: true })
		return store
	}

	private checkpointPath() {
		return join(this.runDir, 'checkpoint.json')
	}

	private jsonlPath(endpoint: PartType) {
		return join(this.runDir, `${endpoint}.jsonl`)
	}

	/**
	 * Pages already written for each endpoint, so a resumed run can skip them.
	 */
	async readCheckpoint(): Promise<Record<string, number[]>> {
		try {
			return JSON.parse(await readFile(this.checkpointPath(), 'utf8'))
		} catch {
			return {}
		}
	}

	async appendPage(endpoint: PartType, page: number, parts: Part[]) {
		if (parts.length) {
			const lines = parts.map((p) => JSON.stringify(p)).join('\n') + '\n'
			await appendFile(this.jsonlPath(endpoint), lines, 'utf8')
		}

		// Checkpoint after the rows are durable, never before.
		const checkpoint = await this.readCheckpoint()
		const pages = checkpoint[endpoint] ?? []
		if (!pages.includes(page)) pages.push(page)
		checkpoint[endpoint] = pages
		await writeFile(
			this.checkpointPath(),
			JSON.stringify(checkpoint, null, '\t'),
			'utf8'
		)
	}

	/**
	 * Rewrites the append-only JSONL as a JSON array, streaming line by line
	 * so a large category is never held in memory in full.
	 */
	async finalize(endpoint: PartType): Promise<number> {
		const source = this.jsonlPath(endpoint)
		const target = join(this.runDir, `${endpoint}.json`)

		const out = createWriteStream(target, 'utf8')
		const write = (chunk: string) =>
			new Promise<void>((resolve, reject) => {
				out.write(chunk, (error) => (error ? reject(error) : resolve()))
			})

		let count = 0

		try {
			await write('[')

			try {
				const rl = createInterface({
					input: createReadStream(source, 'utf8'),
					crlfDelay: Infinity,
				})

				for await (const line of rl) {
					if (line.trim() === '') continue
					await write(count === 0 ? line : ',' + line)
					count++
				}
			} catch (error: any) {
				// No JSONL means the endpoint produced no rows, which is a
				// legitimate outcome (a failed endpoint still gets an empty file).
				if (error?.code !== 'ENOENT') throw error
			}

			await write(']')
		} finally {
			await new Promise<void>((resolve) => out.end(resolve))
		}

		return count
	}

	async writeReport(report: RunReport) {
		await writeFile(
			join(this.runDir, 'report.json'),
			JSON.stringify(report, null, '\t'),
			'utf8'
		)
	}

	/** Points `<outDir>/latest` at this run. Best-effort; never fails the run. */
	async linkLatest() {
		const link = join(this.outDir, 'latest')
		try {
			await rm(link, { recursive: true, force: true })
			await mkdir(dirname(link), { recursive: true })
			await symlink(resolve(this.runDir), link, 'dir')
		} catch {
			// Symlinks are unavailable on some filesystems; the run still stands.
		}
	}
}
