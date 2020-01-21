/** Wait and resolve after the given number of milliseconds */
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Nominal type to enforce usage of custom type guards */
export type Brand<K, T> = K & { readonly __brand: T }

// TODO
// export const throttle = <T extends (...args: any[]) => any>(run: T, period: number): T => {
//   let ready = true

//   return (...args: Parameters<T>): ReturnType<T> => {
//     // if (!ready) {
//     //   return
//     // }

//     ready = false

//     setTimeout(() => {
//       ready = true
//     }, period)

//     return run(...args)
//   }
// }
