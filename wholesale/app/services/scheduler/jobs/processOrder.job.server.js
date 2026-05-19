import connectDB from '../../../db.server'
import { processShopifyOrder } from '../../orders/processOrder.server'
import { createLogger } from '../../logger.server'

export const PROCESS_ORDER_JOB = 'process-shopify-order'
const log = createLogger('job.process_order')

export function registerProcessOrderJob(agenda) {
  agenda.define(
    PROCESS_ORDER_JOB,
    { concurrency: 5, lockLifetime: 5 * 60 * 1000 },
    async (job) => {
      const { shop, order, webhookId } = job.attrs.data || {}
      if (!shop || !order?.id) {
        log.error('job.bad_payload', { data: job.attrs.data })
        return
      }
      await connectDB()
      try {
        await processShopifyOrder({ shop, order, webhookId })
      } catch (err) {
        // Re-throw so Agenda marks the job as failed and surfaces it
        // via the fail event for alerting.
        log.error('job.failed', { shop, shopifyOrderId: order.id, webhookId, err })
        throw err
      }
    },
  )
}
