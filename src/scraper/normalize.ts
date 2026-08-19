import untypedMap from '../serialization-map.json'
import {
	customSerializers,
	genericSerialize,
	serializeNumber,
} from '../serializers'
import type {
	DriftRecord,
	Part,
	PartType,
	RawProduct,
	SerializationMap,
} from '../types'
import { ORIGIN } from './config'

const map = untypedMap as unknown as SerializationMap

/** `Price / GB` -> `price_gb`. Only used for labels we have no mapping for. */
export function autoKey(label: string): string {
	return label
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
}

/**
 * Collects everything PCPartPicker showed us that `serialization-map.json`
 * does not describe, plus everything the map describes that PCPartPicker
 * stopped showing.
 *
 * This exists because the previous scraper threw on the first unmapped spec
 * label, which meant a single new column on PCPartPicker's side silently
 * truncated an entire category to a `.incomplete` file. Schema drift is a
 * fact of life when scraping someone else's HTML; it should be a report, not
 * a crash.
 */
export class DriftCollector {
	private readonly seen = new Map<string, DriftRecord>()
	private readonly labelsObserved = new Map<PartType, Set<string>>()

	record(endpoint: PartType, label: string, sampleValue: string | null) {
		const key = `${endpoint} ${label}`
		const existing = this.seen.get(key)

		if (existing) {
			existing.count++
			if (existing.sampleValue == null) existing.sampleValue = sampleValue
			return
		}

		this.seen.set(key, { endpoint, label, sampleValue, count: 1 })
	}

	observe(endpoint: PartType, label: string) {
		let set = this.labelsObserved.get(endpoint)
		if (!set) {
			set = new Set()
			this.labelsObserved.set(endpoint, set)
		}
		set.add(label)
	}

	forEndpoint(endpoint: PartType): DriftRecord[] {
		return [...this.seen.values()].filter((d) => d.endpoint === endpoint)
	}

	/**
	 * Mapped labels that never showed up — PCPartPicker likely dropped them.
	 *
	 * Returns nothing when no label at all was observed for the endpoint:
	 * that means no rows went through normalization (a fully resumed run, or
	 * one that failed before it read anything), and absence cannot be
	 * distinguished from "we never looked".
	 */
	missingFor(endpoint: PartType): string[] {
		const observed = this.labelsObserved.get(endpoint)
		if (!observed?.size) return []

		return Object.keys(map[endpoint] ?? {}).filter(
			(label) => !observed.has(label)
		)
	}

	get size() {
		return this.seen.size
	}
}

/**
 * `JSON.stringify(NaN)` is `null`, so a serializer that returns NaN writes a
 * value indistinguishable from a genuinely absent one. Catch it here and say
 * so, rather than letting bad parses masquerade as missing data.
 */
function scrubNaN(
	value: any,
	field: string,
	rawValue: string,
	warnings: string[]
): any {
	if (typeof value === 'number' && Number.isNaN(value)) {
		warnings.push(
			`${field} serialized ${JSON.stringify(rawValue)} to NaN; stored null`
		)
		return null
	}

	if (Array.isArray(value) && value.some((v) => Number.isNaN(v))) {
		warnings.push(
			`${field} serialized ${JSON.stringify(rawValue)} to an array containing NaN; stored null`
		)
		return null
	}

	return value
}

export interface NormalizeResult {
	part: Part
	/** Non-fatal problems worth surfacing in the run report. */
	warnings: string[]
}

export function normalize(
	endpoint: PartType,
	raw: RawProduct,
	drift: DriftCollector
): NormalizeResult {
	const warnings: string[] = []
	const part: Part = {}

	part['name'] = raw.name
	if (!raw.name) warnings.push('row has no name')

	// Identity. The legacy scraper captured neither, which made rows
	// impossible to dedupe across runs or join against retailer listings.
	part['id'] = raw.id
	part['url'] = null

	if (raw.path) {
		try {
			part['url'] = new URL(raw.path, ORIGIN).toString()
		} catch {
			// `new URL` throws on hrefs the WHATWG parser rejects. One
			// malformed link must not take the whole category down with it.
			warnings.push(`unparseable product href ${JSON.stringify(raw.path)}`)
		}
	}

	part['price'] =
		raw.priceText == null || raw.priceText.trim() === ''
			? null
			: serializeNumber(raw.priceText)

	const endpointMap = map[endpoint] ?? {}

	for (const { label, value } of raw.specs) {
		drift.observe(endpoint, label)

		const mapped = endpointMap[label]

		if (!mapped) {
			// Unmapped: keep the raw value under a derived key so no data is
			// lost, and flag it so `serialization-map.json` can be updated.
			drift.record(endpoint, label, value)
			const key = autoKey(label)
			if (key && !(key in part)) part[key] = value
			continue
		}

		const [field, serialization] = mapped

		if (value == null) {
			part[field] = null
			continue
		}

		if (serialization === 'custom') {
			const serializer = customSerializers[endpoint]?.[field]
			if (!serializer) {
				warnings.push(
					`no custom serializer for ${endpoint}.${field}; kept raw value`
				)
				part[field] = value
				continue
			}
			try {
				part[field] = scrubNaN(
					serializer(value),
					`${endpoint}.${field}`,
					value,
					warnings
				)
			} catch (error) {
				warnings.push(
					`custom serializer ${endpoint}.${field} failed on ${JSON.stringify(
						value
					)}: ${error}`
				)
				part[field] = value
			}
			continue
		}

		part[field] = genericSerialize(value, serialization)
	}

	return { part, warnings }
}
