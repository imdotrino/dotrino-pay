/**
 * EL PRECIO CON IMPUESTOS, en centavos para no redondear dos veces. Devuelve cadenas con dos
 * decimales, que es lo que piden los proveedores (`"1.14"`), y el impuesto se redondea UNA vez
 * sobre el subtotal entero, no por unidad.
 *
 *   priceWithTax({ unitCents: 99, quantity: 10, taxPercent: 15 })
 *   → { subtotal: '9.90', tax: '1.49', total: '11.39' }
 */
import { PayError } from './errors.js'

export function priceWithTax ({ unitCents, quantity = 1, taxPercent }) {
  if (!Number.isInteger(unitCents) || unitCents < 0) throw new PayError('bad-price', 'unitCents must be a non-negative integer')
  if (!Number.isInteger(quantity) || quantity < 1) throw new PayError('bad-price', 'quantity must be a positive integer')
  if (!Number.isFinite(taxPercent) || taxPercent < 0) throw new PayError('bad-price', 'taxPercent must be a non-negative number')
  const subtotal = unitCents * quantity
  const tax = Math.round(subtotal * taxPercent / 100)
  return { subtotal: usd(subtotal), tax: usd(tax), total: usd(subtotal + tax) }
}

const usd = (cents) => (cents / 100).toFixed(2)

export default { priceWithTax }
