/**
 * PAYPAL, por redirección: el comprador aprueba en paypal.com y vuelve. En la página no se
 * carga NADA de PayPal (`CLAUDE.md`: nada de JavaScript de terceros); todo esto corre en el
 * servidor de quien cobra.
 *
 * A PayPal le llega el importe, una descripción fija y un número de un solo uso (`custom_id`).
 * Ni la cuenta de Dotrino ni nada del usuario.
 *
 * Dos formas de cobrar, las dos aquí:
 *
 *   · un pago suelto (Orders v2): `createOrder` → el comprador aprueba → `captureOrder`
 *   · una suscripción (Billing v1): `createSubscription` → aprueba → `getSubscription`, y
 *     PayPal cobra solo cada periodo; `cancelSubscription` para dejar de cobrar
 *
 * Y lo que lleva una suscripción alrededor: comprobar un webhook (`verifyWebhook`, se lo
 * pregunta a PayPal) y dar de alta el producto, el plan y el webhook (una vez por entorno).
 */
import { PayError } from './errors.js'

const BASES = { live: 'https://api-m.paypal.com', sandbox: 'https://api-m.sandbox.paypal.com' }
const ORDER_ID = /^[A-Z0-9]{6,40}$/
const SUB_ID = /^I-[A-Z0-9]{6,40}$/

export function paypalClient ({ clientId, secret, live = false, fetch = globalThis.fetch }) {
  if (!clientId || !secret) throw new PayError('provider-error', 'paypal: clientId and secret are required')
  const base = live ? BASES.live : BASES.sandbox
  let token = null

  async function call (path, { method = 'GET', body } = {}) {
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${await accessToken()}` }
    const res = await fetch(base + path, { method, headers, body: typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch (_) { data = { raw: text } }
    if (!res.ok) {
      // PayPal pone el motivo real en `details[].issue` (INSTRUMENT_DECLINED, ORDER_NOT_APPROVED…);
      // `message` es siempre la misma frase genérica. Un rechazo del medio de pago es del
      // comprador, no del servidor: lleva su propio código para que la página lo diga y le
      // mande de vuelta a PayPal a elegir otro.
      const issue = data?.details?.[0]?.issue || null
      const declined = issue === 'INSTRUMENT_DECLINED'
      const code = declined ? 'payment-declined' : res.status === 404 ? 'provider-not-found' : 'provider-error'
      throw new PayError(code, `paypal ${method} ${path}: ${res.status} ${issue || data?.name || ''} ${declined ? '' : data?.message || ''}`.trim(), { issue, status: res.status })
    }
    return data
  }

  async function accessToken () {
    if (token && token.until > Date.now()) return token.value
    const auth = 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64')
    const res = await fetch(base + '/v1/oauth2/token', { method: 'POST', headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data?.access_token) throw new PayError('provider-error', `paypal token: ${res.status}`, { status: res.status })
    token = { value: data.access_token, until: Date.now() + Math.max(0, (data.expires_in - 60) * 1000) }
    return token.value
  }

  const check = (re, id, what) => { if (!re.test(String(id || ''))) throw new PayError('bad-id', `paypal: bad ${what} id`) }

  return {
    provider: 'paypal',
    live,

    // ---- pago suelto ----------------------------------------------------------------

    /** @returns {Promise<{ id:string, approveUrl:string }>} */
    async createOrder ({ subtotal, tax, total, description, customId, returnUrl, cancelUrl }) {
      const data = await call('/v2/checkout/orders', {
        method: 'POST',
        body: {
          intent: 'CAPTURE',
          purchase_units: [{
            description,
            custom_id: customId,
            amount: { currency_code: 'USD', value: total, breakdown: { item_total: { currency_code: 'USD', value: subtotal }, tax_total: { currency_code: 'USD', value: tax } } }
          }],
          payment_source: { paypal: { experience_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' } } }
        }
      })
      const approveUrl = (data.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href
      if (!data.id || !approveUrl) throw new PayError('provider-error', 'paypal: order without approval link')
      return { id: data.id, approveUrl }
    },

    /** @returns {Promise<{ status:string, customId:string|null, amount:string|null }>} */
    async captureOrder (id) {
      check(ORDER_ID, id, 'order')
      const data = await call(`/v2/checkout/orders/${id}/capture`, { method: 'POST', body: '{}' })
      const unit = data.purchase_units?.[0]
      const cap = unit?.payments?.captures?.[0]
      return { status: cap?.status || data.status, customId: cap?.custom_id ?? unit?.custom_id ?? null, amount: cap?.amount?.value ?? null }
    },

    // ---- suscripción ----------------------------------------------------------------

    /** @returns {Promise<{ id:string, approveUrl:string }>} */
    async createSubscription ({ planId, customId, returnUrl, cancelUrl, brand = 'Dotrino' }) {
      const data = await call('/v1/billing/subscriptions', {
        method: 'POST',
        body: {
          plan_id: planId,
          custom_id: customId,
          application_context: { brand_name: brand, user_action: 'SUBSCRIBE_NOW', shipping_preference: 'NO_SHIPPING', return_url: returnUrl, cancel_url: cancelUrl }
        }
      })
      const approveUrl = (data.links || []).find((l) => l.rel === 'approve')?.href
      if (!data.id || !approveUrl) throw new PayError('provider-error', 'paypal: subscription without approval link')
      return { id: data.id, approveUrl }
    },

    /**
     * Lo que importa de una suscripción. `paidThrough` es hasta cuándo está pagada: el próximo
     * cobro mientras está activa. Cancelada, PayPal ya no lo da, y vale el que se guardó antes.
     * @returns {Promise<{ id, status, planId, customId, paidThrough:number|null }>}
     */
    async getSubscription (id) {
      check(SUB_ID, id, 'subscription')
      const d = await call(`/v1/billing/subscriptions/${id}`)
      const next = d.billing_info?.next_billing_time ? Date.parse(d.billing_info.next_billing_time) : null
      return { id: d.id, status: d.status, planId: d.plan_id, customId: d.custom_id ?? null, paidThrough: Number.isFinite(next) ? next : null }
    },

    async cancelSubscription (id, reason = 'cancelled by the account') {
      check(SUB_ID, id, 'subscription')
      await call(`/v1/billing/subscriptions/${id}/cancel`, { method: 'POST', body: { reason } })
    },

    /**
     * ¿Este webhook lo mandó PayPal? Lo dice PayPal (`verify-webhook-signature`), con las
     * cabeceras de la petición y el cuerpo tal cual llegó.
     */
    async verifyWebhook ({ headers, event, webhookId }) {
      const h = (k) => headers[k] || headers[k.toLowerCase()]
      const d = await call('/v1/notifications/verify-webhook-signature', {
        method: 'POST',
        body: {
          auth_algo: h('paypal-auth-algo'),
          cert_url: h('paypal-cert-url'),
          transmission_id: h('paypal-transmission-id'),
          transmission_sig: h('paypal-transmission-sig'),
          transmission_time: h('paypal-transmission-time'),
          webhook_id: webhookId,
          webhook_event: event
        }
      })
      return d?.verification_status === 'SUCCESS'
    },

    // ---- alta, una vez por entorno ----------------------------------------------------

    async createProduct ({ name, description }) {
      return call('/v1/catalogs/products', { method: 'POST', body: { name, description, type: 'SERVICE', category: 'SOFTWARE' } })
    },

    /** Un plan mensual de `price` (sin impuestos) con `taxPercent` encima. */
    async createPlan ({ productId, name, price, taxPercent }) {
      return call('/v1/billing/plans', {
        method: 'POST',
        body: {
          product_id: productId,
          name,
          billing_cycles: [{ frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: price, currency_code: 'USD' } } }],
          payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
          taxes: { percentage: String(taxPercent), inclusive: false }
        }
      })
    },

    async createWebhook ({ url, eventTypes }) {
      return call('/v1/notifications/webhooks', { method: 'POST', body: { url, event_types: eventTypes.map((name) => ({ name })) } })
    },

    async listWebhooks () { return (await call('/v1/notifications/webhooks')).webhooks || [] }
  }
}

export default { paypalClient }
