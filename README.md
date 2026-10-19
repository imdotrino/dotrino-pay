# @dotrino/pay

Los cobros del ecosistema Dotrino, en un solo sitio. Cada servicio que cobra (el directorio de
nombres, las cuentas de la bóveda alojada) usa esto en vez de escribir su propio cliente del
proveedor.

- **PayPal** (`paypalClient`): pago suelto (pedidos) y suscripción mensual, comprobar un webhook
  preguntándole a PayPal, y dar de alta producto, plan y webhook. Por redirección: en la página
  no se carga nada de PayPal.
- **El precio con impuestos** (`priceWithTax`): en centavos, el impuesto redondeado una vez.
- **Errores con código** (`PayError`): `payment-declined` (el comprador elige otro medio),
  `provider-not-found`, `provider-error`, `bad-id`, `bad-price`.

Otro proveedor (PayPhone, Lightning) entra aquí como otro módulo, con los mismos códigos.

```js
import { paypalClient, priceWithTax } from '@dotrino/pay'

const paypal = paypalClient({ clientId, secret, live: false })
const { subtotal, tax, total } = priceWithTax({ unitCents: 99, quantity: 1, taxPercent: 15 })
const { id, approveUrl } = await paypal.createOrder({ subtotal, tax, total, description, customId, returnUrl, cancelUrl })
```

Nunca se vende dentro de una app nativa (`CONVENCIONES-APPS.md` §16.5): eso lo decide la página
que cobra, no este paquete.

## Desarrollar

```bash
npm install
npm test
```

Se publica desde CI al empujar un tag `vX.Y.Z` (`.github/workflows/release.yml`). Licencia MIT.
