/**
 * @dotrino/pay — los cobros del ecosistema, en UN sitio.
 *
 * Cada servicio que cobra (el directorio de nombres, las cuentas de la bóveda alojada) lo hace
 * con esto, no con su propia copia del cliente del proveedor. Hoy hay un proveedor, PayPal;
 * PayPhone o Lightning entran aquí como otro módulo, con los mismos códigos de error.
 */
export { paypalClient } from './paypal.js'
export { priceWithTax } from './price.js'
export { PayError } from './errors.js'
