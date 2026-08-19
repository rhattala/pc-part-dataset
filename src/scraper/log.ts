const started = Date.now()

const stamp = () => {
	const elapsed = ((Date.now() - started) / 1000).toFixed(1).padStart(6)
	return `[${elapsed}s]`
}

export const log = {
	info: (message: string) => console.log(`${stamp()} ${message}`),
	warn: (message: string) => console.warn(`${stamp()} WARN  ${message}`),
	error: (message: string) => console.error(`${stamp()} ERROR ${message}`),
}

export const sleep = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms))

/** Base delay plus 0..jitter, so navigations do not land on a fixed cadence. */
export const politeDelay = (baseMs: number, jitterMs: number) =>
	sleep(baseMs + Math.random() * jitterMs)

/**
 * Retries `fn` with exponential backoff. Returns the last error if every
 * attempt fails, rather than throwing, so callers can record a partial
 * result instead of losing the whole endpoint.
 */
export async function withRetry<T>(
	label: string,
	attempts: number,
	fn: (attempt: number) => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
	let lastError: Error = new Error('no attempts made')

	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return { ok: true, value: await fn(attempt) }
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error))

			if (attempt < attempts) {
				const backoff = 2 ** (attempt - 1) * 1000 + Math.random() * 500
				log.warn(
					`${label} attempt ${attempt}/${attempts} failed: ` +
						`${lastError.message}; retrying in ${Math.round(backoff)}ms`
				)
				await sleep(backoff)
			}
		}
	}

	return { ok: false, error: lastError }
}

/**
 * Runs `worker` over `items` with at most `limit` in flight. Replaces
 * puppeteer-cluster, which pinned the project to puppeteer 20 and has seen
 * little maintenance.
 */
export async function pool<T, R>(
	items: T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const results = new Array<R>(items.length)
	let cursor = 0

	const runners = Array.from(
		{ length: Math.max(1, Math.min(limit, items.length)) },
		async () => {
			while (true) {
				const index = cursor++
				if (index >= items.length) return
				results[index] = await worker(items[index]!, index)
			}
		}
	)

	await Promise.all(runners)
	return results
}
