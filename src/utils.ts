/** Wait and resolve after the given number of milliseconds */
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Nominal type to enforce usage of custom type guards */
export type Brand<K, T> = K & { readonly __brand: T }

/**
 * Create a function that runs the given function once per period, ignoring subsequent calls
 * @param func Function to execute once per period
 * @param period Number of milliseconds between function calls
 */
export function throttle<F extends Function>(func: F, period: number): F {
  let ready = true

  return ((...args: any[]) => {
    if (!ready) {
      return
    }

    setTimeout(() => {
      ready = true
    }, period)

    func(...args)
  }) as any
}
