import { MultiOptions, Pipeline } from 'ioredis'

// TODO Add docs here

// TODO Potential problem here: will modules that depend on this reference the correct Redis type?

declare module 'ioredis' {
  export interface Pipeline {
    addSettlementCredit(accountId: string, idempotencyKey: string, amount: string): Pipeline
    deleteAccount(accountId: string): Pipeline

    exec(): Promise<Array<[Error | null, string]> | null>
  }

  export interface Redis {
    createAccount(accountId: string): Promise<0 | 1>
    queueSettlement(
      accountId: string,
      idempotencyKey: string,
      amount: string
    ): Promise<[string, 1 | null]>
    prepareSettlement(accountId: string, leaseDuration: number): Promise<string[]>
    retrySettlementCredit(): Promise<[string, string, string] | null>
    finalizeSettlementCredit(accountId: string, idempotencyKey: string): Promise<void>
  }
}
