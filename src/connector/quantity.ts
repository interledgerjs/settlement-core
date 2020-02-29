import BigNumber from 'bignumber.js'
import { Brand } from '../utils'

/** Match only characters 0-9 */
const NUMERIC_REGEX = new RegExp(/^\d+$/)

/** Convert a Quantity to an arbitrary precision amount in the standard unit of the asset */
export const fromQuantity = ({ amount, scale }: Quantity): BigNumber =>
  new BigNumber(amount).shiftedBy(-scale)

/**
 * Amount denominated in some unit of a single, fungible asset
 * - Using a nominal/branded type ensures that we've validated
 *   using the `isQuantity` predicate
 */
export type Quantity = Brand<
  {
    /** Amount of the unit, which is a non-negative integer */
    amount: string
    /** Difference in orders of magnitude between the standard unit and a corresponding fractional unit */
    scale: number
  },
  'Quantity'
>

/** Is the given object a valid `Quantity` per the Settlement Engine RFC? */
export const isQuantity = (o: any): o is Quantity =>
  !!o && // Prevent TypeError if o is `null`
  typeof o === 'object' &&
  typeof o.scale === 'number' &&
  Number.isInteger(o.scale) &&
  o.scale >= 0 &&
  o.scale <= 255 &&
  typeof o.amount === 'string' &&
  NUMERIC_REGEX.test(o.amount) &&
  new BigNumber(o.amount).isInteger() &&
  +o.amount >= 0
