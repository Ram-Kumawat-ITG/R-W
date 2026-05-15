import { step1Schema } from './step1.schema'
import { step2Schema } from './step2.schema'
import { step3Schema } from './step3.schema'

// Merged schema for final submit-time validation. Each step's shape is
// validated; cross-step rules can be added here if needed later.
export const fullSchema = step1Schema.concat(step2Schema).concat(step3Schema)
