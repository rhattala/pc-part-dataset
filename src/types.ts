export type PartType =
	| 'cpu'
	| 'cpu-cooler'
	| 'motherboard'
	| 'memory'
	| 'internal-hard-drive'
	| 'video-card'
	| 'case'
	| 'power-supply'
	| 'os'
	| 'monitor'
	| 'sound-card'
	| 'wired-network-card'
	| 'wireless-network-card'
	| 'headphones'
	| 'keyboard'
	| 'mouse'
	| 'speakers'
	| 'webcam'
	| 'case-accessory'
	| 'case-fan'
	| 'fan-controller'
	| 'thermal-paste'
	| 'external-hard-drive'
	| 'optical-drive'
	| 'ups'

export type Part = Record<string, any>

export type MappedSerialization = [string, boolean | 'custom']
export type SerializationMap = Record<
	PartType,
	Record<string, MappedSerialization>
>

/**
 * What `extract.ts` pulls out of a single product row, before any
 * serialization. Deliberately dumb and lossless: every spec is kept as the
 * raw label/value pair PCPartPicker rendered, so that normalization (and any
 * failure in it) happens in Node where we can report on it, not inside the
 * page where a throw kills the whole run.
 */
export interface RawProduct {
	name: string | null
	/** Relative PCPartPicker product path, e.g. `/product/9nm323/...`. */
	path: string | null
	/** PCPartPicker's own product id, parsed out of `path`. */
	id: string | null
	priceText: string | null
	ratingText: string | null
	specs: Array<{ label: string; value: string | null }>
}

/** A single unmapped spec label seen during a run. */
export interface DriftRecord {
	endpoint: PartType
	label: string
	sampleValue: string | null
	count: number
}

export interface EndpointReport {
	endpoint: PartType
	status: 'ok' | 'partial' | 'failed'
	pagesExpected: number | null
	pagesScraped: number
	rows: number
	rowsInvalid: number
	/** Mapped spec labels that never appeared — PCPartPicker may have dropped them. */
	missingMappedLabels: string[]
	drift: DriftRecord[]
	errors: string[]
	durationMs: number
}

export interface RunReport {
	runId: string
	startedAt: string
	finishedAt: string
	baseUrl: string
	endpoints: EndpointReport[]
	totals: {
		rows: number
		rowsInvalid: number
		endpointsOk: number
		endpointsPartial: number
		endpointsFailed: number
		driftLabels: number
	}
}
