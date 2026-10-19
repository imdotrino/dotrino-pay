/**
 * El cliente de PayPal contra un PayPal fingido (un `fetch` que contesta lo que contestaría la
 * API), y el precio con impuestos. Lo que se prueba es lo que deciden los servicios que cobran:
 * qué código lleva cada fallo, qué se manda a PayPal y qué se lee de vuelta.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { paypalClient, priceWithTax, PayError } from '../src/index.js'

/** Un PayPal de mentira: `routes['POST /v2/checkout/orders'] = (body) => [status, json]`. */
function fakePaypal (routes) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const path = url.replace(/^https:\/\/api-m(\.sandbox)?\.paypal\.com/, '')
    const key = `${init.method || 'GET'} ${path}`
    calls.push({ key, url, body: init.body ? (typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body) : null, headers: init.headers })
    if (key === 'POST /v1/oauth2/token') return reply(200, { access_token: 'tok', expires_in: 3600 })
    const r = routes[key]
    if (!r) return reply(404, { name: 'RESOURCE_NOT_FOUND', message: 'nope' })
    const [status, json] = r(calls.at(-1).body)
    return reply(status, json)
  }
  return { fetch, calls }
}
const reply = (status, json) => ({ ok: status < 400, status, text: async () => JSON.stringify(json), json: async () => json })

test('el precio: el impuesto se redondea una vez, sobre el subtotal', () => {
  assert.deepEqual(priceWithTax({ unitCents: 99, taxPercent: 15 }), { subtotal: '0.99', tax: '0.15', total: '1.14' })
  assert.deepEqual(priceWithTax({ unitCents: 99, quantity: 10, taxPercent: 15 }), { subtotal: '9.90', tax: '1.49', total: '11.39' })
  assert.deepEqual(priceWithTax({ unitCents: 500, taxPercent: 15 }), { subtotal: '5.00', tax: '0.75', total: '5.75' })
  assert.throws(() => priceWithTax({ unitCents: 99, quantity: 0, taxPercent: 15 }), { code: 'bad-price' })
  assert.throws(() => priceWithTax({ unitCents: 1.5, taxPercent: 15 }), { code: 'bad-price' })
})

test('sin credencial no hay cliente', () => {
  assert.throws(() => paypalClient({ clientId: '', secret: 'x' }), (e) => e instanceof PayError && e.code === 'provider-error')
})

test('pago suelto: pide el pedido con el desglose, y la captura dice qué se pagó', async () => {
  const pp = fakePaypal({
    'POST /v2/checkout/orders': () => [201, { id: 'ORD12345', links: [{ rel: 'payer-action', href: 'https://paypal.test/a' }] }],
    'POST /v2/checkout/orders/ORD12345/capture': () => [201, { status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ status: 'COMPLETED', custom_id: 'c1', amount: { value: '1.14' } }] } }] }]
  })
  const p = paypalClient({ clientId: 'id', secret: 's', fetch: pp.fetch })
  const o = await p.createOrder({ subtotal: '0.99', tax: '0.15', total: '1.14', description: 'x', customId: 'c1', returnUrl: 'https://r', cancelUrl: 'https://c' })
  assert.deepEqual(o, { id: 'ORD12345', approveUrl: 'https://paypal.test/a' })
  const sent = pp.calls.find((c) => c.key === 'POST /v2/checkout/orders').body
  assert.equal(sent.purchase_units[0].amount.value, '1.14')
  assert.equal(sent.purchase_units[0].custom_id, 'c1')
  assert.deepEqual(await p.captureOrder('ORD12345'), { status: 'COMPLETED', customId: 'c1', amount: '1.14' })
  await assert.rejects(p.captureOrder('nope!'), { code: 'bad-id' })
})

test('un medio de pago rechazado es del comprador: payment-declined; lo demás, provider-error o provider-not-found', async () => {
  const pp = fakePaypal({
    'POST /v2/checkout/orders/ORD12345/capture': () => [422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] }],
    'POST /v2/checkout/orders/ORD99999/capture': () => [500, { name: 'INTERNAL', message: 'boom' }]
  })
  const p = paypalClient({ clientId: 'id', secret: 's', fetch: pp.fetch })
  await assert.rejects(p.captureOrder('ORD12345'), (e) => e.code === 'payment-declined' && e.issue === 'INSTRUMENT_DECLINED')
  await assert.rejects(p.captureOrder('ORD99999'), (e) => e.code === 'provider-error' && e.status === 500)
  await assert.rejects(p.getSubscription('I-NOEXISTE1'), { code: 'provider-not-found' })
})

test('suscripción: alta con el plan y el custom_id, y lo que se lee de vuelta', async () => {
  const pp = fakePaypal({
    'POST /v1/billing/subscriptions': () => [201, { id: 'I-ABC123456', links: [{ rel: 'approve', href: 'https://paypal.test/s' }] }],
    'GET /v1/billing/subscriptions/I-ABC123456': () => [200, { id: 'I-ABC123456', status: 'ACTIVE', plan_id: 'P-1', custom_id: 'c2', billing_info: { next_billing_time: '2026-11-18T10:00:00Z' } }],
    'POST /v1/billing/subscriptions/I-ABC123456/cancel': () => [204, null]
  })
  const p = paypalClient({ clientId: 'id', secret: 's', fetch: pp.fetch })
  assert.deepEqual(await p.createSubscription({ planId: 'P-1', customId: 'c2', returnUrl: 'https://r', cancelUrl: 'https://c' }), { id: 'I-ABC123456', approveUrl: 'https://paypal.test/s' })
  const body = pp.calls.find((c) => c.key === 'POST /v1/billing/subscriptions').body
  assert.equal(body.plan_id, 'P-1')
  assert.equal(body.custom_id, 'c2')
  assert.deepEqual(await p.getSubscription('I-ABC123456'), { id: 'I-ABC123456', status: 'ACTIVE', planId: 'P-1', customId: 'c2', paidThrough: Date.parse('2026-11-18T10:00:00Z') })
  await p.cancelSubscription('I-ABC123456')
  await assert.rejects(p.getSubscription('ORD12345'), { code: 'bad-id' })
})

test('webhook: lo decide PayPal, con las cabeceras y el evento tal cual', async () => {
  let ok = 'SUCCESS'
  const pp = fakePaypal({ 'POST /v1/notifications/verify-webhook-signature': () => [200, { verification_status: ok }] })
  const p = paypalClient({ clientId: 'id', secret: 's', fetch: pp.fetch })
  const headers = { 'paypal-auth-algo': 'a', 'paypal-cert-url': 'u', 'paypal-transmission-id': 't', 'paypal-transmission-sig': 's', 'paypal-transmission-time': 'w' }
  assert.equal(await p.verifyWebhook({ headers, event: { id: 'E1' }, webhookId: 'WH' }), true)
  const sent = pp.calls.at(-1).body
  assert.equal(sent.webhook_id, 'WH')
  assert.equal(sent.transmission_sig, 's')
  assert.deepEqual(sent.webhook_event, { id: 'E1' })
  ok = 'FAILURE'
  assert.equal(await p.verifyWebhook({ headers, event: {}, webhookId: 'WH' }), false)
})

test('live y sandbox van a sitios distintos', async () => {
  const urls = []
  const fetch = async (url) => { urls.push(url); return reply(200, { access_token: 't', expires_in: 3600, webhooks: [] }) }
  await paypalClient({ clientId: 'i', secret: 's', live: true, fetch }).listWebhooks()
  await paypalClient({ clientId: 'i', secret: 's', fetch }).listWebhooks()
  assert.ok(urls.some((u) => u.startsWith('https://api-m.paypal.com/')))
  assert.ok(urls.some((u) => u.startsWith('https://api-m.sandbox.paypal.com/')))
})

test('devolver: los cobros de una suscripción salen con su id, y ese id es el que se devuelve', async () => {
  const pp = fakePaypal({
    'GET /v1/billing/subscriptions/I-ABC123456/transactions?start_time=2026-10-19T00:00:00.000Z&end_time=2026-10-20T00:00:00.000Z': () => [200, { transactions: [{ id: 'CAP1234567', status: 'COMPLETED', time: '2026-10-19T16:21:40Z', amount_with_breakdown: { gross_amount: { value: '5.75' } } }] }],
    'POST /v2/payments/captures/CAP1234567/refund': () => [201, { id: 'REF7654321', status: 'COMPLETED' }]
  })
  const p = paypalClient({ clientId: 'id', secret: 's', fetch: pp.fetch })
  const pays = await p.subscriptionPayments('I-ABC123456', { since: Date.parse('2026-10-19T00:00:00Z'), until: Date.parse('2026-10-20T00:00:00Z') })
  assert.deepEqual(pays, [{ id: 'CAP1234567', status: 'COMPLETED', amount: '5.75', time: Date.parse('2026-10-19T16:21:40Z') }])
  assert.deepEqual(await p.refundCapture('CAP1234567', { note: 'x' }), { id: 'REF7654321', status: 'COMPLETED' })
  assert.deepEqual(pp.calls.at(-1).body, { note_to_payer: 'x' })
  await assert.rejects(p.refundCapture('../x'), { code: 'bad-id' })
})
