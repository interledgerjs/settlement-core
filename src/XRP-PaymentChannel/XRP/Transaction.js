const sign = require("ripple-sign-keypairs");
const rippleKeyPairs = require("ripple-keypairs");
const binary = require('ripple-binary-codec')
var exports = module.exports = {};

const createChannel = (Account,Amount,Destination,SettleDelay,PublicKey,Sequence,Fee) => {
    const tx = {
        "Account": Account,
        "TransactionType": "PaymentChannelCreate",
        "Amount": Amount,
        "Destination": Destination,
        "SettleDelay": SettleDelay,
        "PublicKey": PublicKey,
        "Sequence": Sequence,
        "Fee": Fee
    }
    return tx
}

const paymentChannel_fund = (Account,Channel,Amount,Fee,Sequence) => {
    const tx = {
        "Account": Account,
        "TransactionType": "PaymentChannelFund",
        "Channel": Channel,
        "Amount": Amount,
        "Fee": Fee,
        "Sequence": Sequence
    }

    return tx
}

const channel_authorize = (channel_id,amount) => {
    const tx = {
        "channel_id": channel_id,
        "amount": amount
    }

    return tx
}

const paymentChannel_claim = (Account,Amount,Balance,Channel,PublicKey,Signature,Fee,Sequence) => {
    const tx = {
        "Account": Account,
        "TransactionType": "PaymentChannelClaim",
        "Amount": Amount,
        "Balance": Balance,
        "Channel": Channel,
        "PublicKey": PublicKey,
        "Signature": Signature,
        "Fee": Fee,
        "Sequence": Sequence
    }

    return tx
}

const paymentChannel_close = (Account,Channel,Fee,Sequence) => {
    const tx = {
        "Account": Account,
        "TransactionType": "PaymentChannelClaim",
        "Channel": Channel,
        "Flags": 2147614720,
        "Fee": Fee,
        "Sequence": Sequence
    }

    return tx
}

const account_channels = (account,destination_account) => {
    const tx = {
        "method": "account_channels",
        "params": [{
            "account": account,
            "destination_account": destination_account,
            "ledger_index": "validated"
        }]
    }

    return tx
}

const signTX = (tx, secret) => {
    var keypair = rippleKeyPairs.deriveKeypair(secret);
    console.log(tx)
    const txJSON = JSON.stringify(tx);
    const txSign = sign(txJSON, keypair);
    return txSign
}

const signMessage = (claim, secret) => {
    var keypair = rippleKeyPairs.deriveKeypair(secret);
    const signingData = binary.encodeForSigningClaim({
        channel: claim.channel_id,
        amount: claim.amount
    })
    return rippleKeyPairs.sign(signingData, keypair.privateKey)
}

const verify = (claim, signature, publicKey) => {
    const signingData = binary.encodeForSigningClaim({
        channel: claim.channel_id,
        amount: claim.amount
    })
    return rippleKeyPairs.verify(signingData, signature, publicKey)
}

exports.createChannel = createChannel
exports.paymentChannel_fund = paymentChannel_fund
exports.channel_authorize = channel_authorize
exports.paymentChannel_claim = paymentChannel_claim
exports.paymentChannel_close = paymentChannel_close
exports.account_channels = account_channels
exports.signTX = signTX
exports.signMessage = signMessage
exports.verify = verify
