/**
 * Los errores de un cobro llevan su `code`, que es el contrato: quien llama decide por él
 * (un rechazo del medio de pago es del comprador y se le dice; un fallo del proveedor es
 * nuestro y se registra), nunca por la frase.
 *
 *   payment-declined    el proveedor rechazó el medio de pago: que el comprador elija otro
 *   provider-not-found  el proveedor no conoce ese pedido o esa suscripción
 *   provider-error      cualquier otro fallo del proveedor (red, credencial, petición)
 *   bad-id              un identificador con una forma que el proveedor no da
 *   bad-price           un precio que no se puede cobrar
 */
export class PayError extends Error {
  constructor (code, message, extra = {}) {
    super(message)
    this.code = code
    Object.assign(this, extra)
  }
}

export default { PayError }
