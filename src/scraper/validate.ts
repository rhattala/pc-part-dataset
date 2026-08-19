import { z } from 'zod'
import type { Part } from '../types'

/**
 * The invariants every row must hold regardless of category. Category-specific
 * fields are intentionally not constrained here — PCPartPicker changes them,
 * and `DriftCollector` is what reports that. This schema exists to catch rows
 * that came back structurally broken (an empty name, a price that parsed to
 * something that is not a number), which is the signal that the page markup
 * moved rather than that a column was added.
 */
export const partSchema = z
	.object({
		name: z.string().min(1),
		id: z.string().min(1).nullable(),
		url: z.string().url().nullable(),
		price: z.union([z.number(), z.array(z.number()), z.null()]),
	})
	.loose()

export interface ValidationResult {
	ok: boolean
	reason?: string
}

export function validatePart(part: Part): ValidationResult {
	const result = partSchema.safeParse(part)
	if (result.success) return { ok: true }

	const first = result.error.issues[0]
	return {
		ok: false,
		reason: first
			? `${first.path.join('.') || '(root)'}: ${first.message}`
			: 'unknown validation failure',
	}
}

/**
 * A run where most rows have no id or no url means the name cell markup
 * changed — the scraper is "succeeding" while quietly producing rows that
 * cannot be joined to anything. Worth failing loudly on.
 */
export function identityCoverage(parts: Part[]) {
	if (!parts.length) return { withId: 0, withUrl: 0, ratio: 0 }

	const withId = parts.filter((p) => p['id']).length
	const withUrl = parts.filter((p) => p['url']).length

	return { withId, withUrl, ratio: withId / parts.length }
}
