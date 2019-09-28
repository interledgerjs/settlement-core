# Settlement Core

> #### Framework for creating Interledger settlement engines in JS

[![NPM Package](https://img.shields.io/npm/v/ilp-settlement-core.svg?style=flat-square&logo=npm)](https://npmjs.org/package/ilp-settlement-core)
[![CircleCI](https://img.shields.io/circleci/project/github/interledgerjs/settlement-core/master.svg?style=flat-square&logo=circleci)](https://circleci.com/gh/interledgerjs/settlement-core/master)
[![Codecov](https://img.shields.io/codecov/c/github/interledgerjs/settlement-core/master.svg?style=flat-square&logo=codecov)](https://codecov.io/gh/interledgerjs/settlement-core)
[![Prettier](https://img.shields.io/badge/code_style-prettier-brightgreen.svg?style=flat-square)](https://prettier.io/)
[![Apache 2.0 License](https://img.shields.io/github/license/interledgerjs/settlement-core.svg?style=flat-square)](https://github.com/interledgerjs/settlement-core/blob/master/LICENSE)

## Get Started

If you're looking to operate a settlement engine with your connector or integrate one into your app or service, check out these awesome implementations!

| Settlement Engine                                                  | Supported Assets | Status              | Language   | Authors                                                                                            |
| ------------------------------------------------------------------ | ---------------- | ------------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| [Ethereum (on-ledger)](https://github.com/interledger-rs/interledger-rs/tree/master/examples/eth-settlement)                                           | ETH, ERC-20s     | _Beta_              | Rust       | [Georgios Konstantopoulos](https://github.com/gakonst/)                                            |
| [XRP (on-ledger)](https://github.com/interledgerjs/settlement-xrp) | XRP              | _Beta_              | TypeScript | [Matt de Haast](https://github.com/matdehaast/), [Kincaid O'Neil](https://github.com/kincaidoneil) |
| [Lightning](http://github.com/interledgerjs/settlement-lightning)  | BTC              | _Under development_ | TypeScript | [Kincaid O'Neil](https://github.com/kincaidoneil)                                                  |

If you want learn more about settlement engines or develop a new one, keep reading!

## Overview

### Settlement in Interledger

In the [Interledger protocol](https://interledger.org/rfcs/0001-interledger-architecture/), connectors maintain peers, or counterparties whom they transact with. Connectors clear and fulfill ILP packets with their peers, which represent conditional IOUs that affect financial accounting balances betwen them.

A connector may extend a given peer a limited line of credit, or none at all, depending upon their trustworthiness. As the connector receives incoming ILP Prepare packets from a peer, forwards them, and returns corresponding ILP Fulfill packets, that peer's liabilities to the connector accrue. If the peer's liabilities exceed the credit limit assigned to it, the connector may reject and decline to forward additional packets.

In order to continue transacting, the peer must settle their liabilities. In most cases, this is accomplished through sending a payment on a settlement system that both peers have agreed to use. The connector should credit the incoming payment, irrevocably discharging a sum the peer owed to it, which enables clearing subsequent Interledger packets from the peer.

Settlement systems transfer value from one participant to another, and include:

- Cryptocurrencies and distributed ledgers (_Bitcoin, Ethereum, XRP..._)
- Payment channels and layer 2 networks (_Lightning, state channels..._)
- Traditional banking infrastructure (_ACH, SWIFT, wire transfers, card processors..._)
- Money transfer services (_PayPal, Venmo, Square Cash..._)
- Mobile money (_WeChat, Alipay, M-PESA..._)
- Cash or physically delivering assets

### Settlement Engines

_Settlement engines_ are services that integrate with a settlement system to send and receive settlements. Two Interledger peers each operate compatible settlement engines. Since an Interledger connector may have many peers using the same asset, one settlement engine may manage multiple accounts, to settle with many different peers.

The [Settlement Engine specification](TODO-link-to-rfc) defines a standardized HTTP API for Interledger connectors to interface with their settlement engines, and vice versa. Connectors trigger the settlement engine to perform settlements, and settlement engines trigger the connector to adjust accounting balances when incoming settlements are received, like so:

(TODO insert diagram from spec)

Settlement engines may also use the same HTTP API to send and receive messages with a peer's settlement engine. Settlement Core manages all this communication with the connector in the background, exposing a simple interface.

### Design Goals

- **Intuitive**. Provide the essential primitives to quickly develop safe, reliable settlement engine implementations.
- **Scalable**. Support standalone clients all the way up to high-volume, low-latency service providers.
- **Interoperable**. Settlement engines should fully support each next-generation connector, including [Interledger.rs](https://interledger.rs), [Rafiki](https://github.com/interledgerjs/rafiki), and the [Java connector](https://github.com/sappenin/java-ilpv4-connector/).
- **Isomorphic**. JavaScript settlement engines should operate seamlessly across Node.js, desktop & mobile browsers, and Electron apps.

## API

TODO Add installation instructions

🚨 Since this tech is hot off the press, note that the APIs here are beta and subject to change!

Settlement engines can be defined as a factory function: given account services, the function returns a Promise with a constructed settlement engine:

```js
export const connectEngine = async services => {
  // Async tasks to connect engine ...

  return {
    // Settlement engine instance ...
  }
}
```

The `services` parameter includes these callback functions, provided by Settlement Core, to each settlement engine:

```typescript
interface AccountServices {
  /**
   * Send a message to the given account and return their response
   *
   * @param accountId Unique account identifier to send message to
   * @param message Object to be serialized as JSON
   */
  sendMessage(accountId: string, message: any): Promise<any>

  /**
   * Send a notification to the connector to credit the given incoming settlement
   *
   * @param accountId Unique account identifier (recipient of settlement)
   * @param amount Amount received as an incoming settlement
   * @param settlementId Unique identifier for this settlement
   */
  creditSettlement(accountId: string, amount: BigNumber, settlementId?: string): void

  /**
   * Retry failed or queued outgoing settlements
   * - Automatically called after the settlement engine is instantiated
   *
   * @param accountId Unique account identifier
   */
  trySettlement(accountId: string): void
}
```

Then, the function should a return a contructed settlement engine instance that implements this interface:

```typescript
interface SettlementEngine {
  /**
   * Setup the given account and perform tasks as a pre-requisite to send settlements
   * - For example, send a message to the peer to exchange ledger identifiers
   *
   * @param accountId Unique account identifier
   */
  setupAccount?(accountId: string): Promise<void>

  /**
   * Send a settlement to the peer for up to the given amount
   * - Since the amount is provided in arbitrary precision, round to the correct
   *   precision first
   * - The leftover, unsettled amount will automatically be tracked and retried later
   *   based on the amount returned
   * - If Promise is rejected, for safety, the full amount will assumed to be settled
   *
   * @param accountId Unique account identifier
   * @param amount Maximum amount to settle, in standard unit of asset (arbitrary precision)
   * @return Amount settled, in standard unit of asset (arbitrary precision)
   */
  settle(accountId: string, amount: BigNumber): Promise<BigNumber>

  /**
   * Handle and respond to an incoming message from the given peer
   *
   * @param accountId Unique account identifier
   * @param message Parsed JSON message from peer
   * @return Response message, to be serialized as JSON
   */
  handleMessage?(accountId: string, message: any): Promise<any>

  /**
   * Delete or close the given account
   * - For example, clean up database records associated with the account
   *
   * @param accountId Unique account identifier
   */
  closeAccount?(accountId: string): Promise<void>

  /**
   * Disconnect the settlement engine
   * - For example, gracefully closes connections to the ledger and/or databases
   */
  disconnect?(): Promise<void>
}
```

### Running settlement engines

The factory to connect a settlement engine can be provided to Settlement Core, which will start an HTTP server to communicate with the connector using its `startServer` function. For example:

```js
import { connectEngine } from '.'
import { startServer, connectRedis } from 'ilp-settlement-core'

async function run() {
  const store = await connectRedis()
  await startServer(connectEngine, store)
}

run().catch(err => console.error(err))
```

The `startServer` function should also be provided a database (Settlement Core currently supports Redis and a simple in-memory store) and configuration options to connect to the connector. It returns a Promise exposing hooks to shutdown the settlement engine server.

```typescript
type StartServer = (
  /** Factory to connect and instantiate a settlement engine */
  createEngine: ConnectSettlementEngine,

  /** Database for balance logic and basic account handling (default: memory store) */
  store?: SettlementStore,

  /** Configuration for the server with the connector */
  config?: {
    /** URL of the connector's server for this settlement engine (default: http://localhost:7771) */
    connectorUrl?: string

    /** Port to operate the settlement server on (default: 3000) */
    port?: string | number
  }
) => Promise<{
  /** Stop the server interacting with the connector and disconnect the settlement engine */
  shutdown(): Promise<void>
}>

```

### Configuration

How settlement engines are configured is up to implementations: they may use environment variables, config files, or their own method. Settlement engines can take in configuration options using a higher-order function, like so:

```js
export const createEngine = config => async services => {
  // Construct settlement engine...
}
```

Then, to instantiate a settlement engine, first pass in the configuration options, and then pass the factory to Settlement Core when starting the settlement server:

```js
async function run() {
  // Config using environment variables
  const connectorUrl = process.env.CONNECTOR_URL
  const ledgerCredential = process.env.LEDGER_CREDENTIAL

  const store = await connectRedis()

  // Inject config options, which returns factory function to connect settlement engine
  const connectEngine = createEngine({ ledgerCredential })

  // Pass factory function when starting settlement server
  await startServer(connectEngine, store, { connectorUrl })
}
```

### Amounts

Settlement Core using [BigNumber.js](https://github.com/MikeMcl/bignumber.js) to pass around arbitrary precision numbers. For example, in Bitcoin, transaction amounts may denominated in precision of satoshis, which are 8 decimal places. The `BigNumber` type enables these amounts to be represented precisely without losing precision compared to [JavaScript numbers](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Numbers_and_dates#Numbers).

When interfacing with Settlement Core, settlement engines should always handle amounts in the _standard unit_ of the asset, such as USD or BTC. For example, 1 satoshi would be passed as a `BigNumber` of `0.00000001`, denominanted in BTC.

Due to the way connectors track balances, Settlement Core may pass amounts to the settlement engine more precise than can actually be settled on the underlying ledger. In this case of Bitcoin, this would be the equivalent passing a BigNumber representing `0.05000003769`, since there ar more than 8 decimal places. To handle this case, settlement engines should truncate this amount by using calling the `decimalPlaces` method on each amount with the maximum number of decimal places they can settle (always round down). Settlement engines should then return this truncated amount from the `settle` method. Then, Settlement Core will automatically calculate and track this "leftover" amount, which will accrue and be retried later.

### Advanced

_Coming soon_: recommendations for an admin API, database/pub-subs, and a more step-by-step guide!
