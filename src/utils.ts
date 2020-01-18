/** Wait and resolve after the given number of milliseconds */
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
