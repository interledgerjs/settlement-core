const transaction = require("./Transaction")
const axios = require('axios');
const rippleKeyPairs = require("ripple-keypairs");
var Test_Net = "https://s.altnet.rippletest.net:51234"
var PROD_SERVER = "Production server"
var SERVER = Test_Net

var exports = module.exports = {};
const createChannel = (Account, Amount, Destination, SettleDelay, PublicKey, sequence, Fee, secret, callback, error) => {
    const object = transaction.createChannel(Account, Amount, Destination, SettleDelay, PublicKey, sequence, Fee)
    const blob = transaction.signTX(object, secret).signedTransaction
    var tx = {
        "method": "submit",
        "params": [
            {
                "tx_blob": blob
            }
        ]
    }
    submit(tx, callback, error)
}

const fundChannel = (Account, Channel, Amount, Fee, Sequence, secret, callback, error) => {
    const object = transaction.paymentChannel_fund(Account, Channel, Amount, Fee, Sequence)
    const blob = transaction.signTX(object, secret).signedTransaction
    var tx = {
        "method": "submit",
        "params": [
            {
                "tx_blob": blob
            }
        ]
    }
    submit(tx, callback, error)
}

const closeChannel = (Account, Channel, Fee, Sequence, secret, callback, error) => {
    const object = transaction.paymentChannel_close(Account, Channel, Fee, Sequence)
    const blob = transaction.signTX(object, secret).signedTransaction
    var tx = {
        "method": "submit",
        "params": [
            {
                "tx_blob": blob
            }
        ]
    }
    submit(tx, callback, error)
}

const claim = (channel_id, amount) => {
    return transaction.channel_authorize(channel_id, amount)
}

const signClaim = (claim, secret) => {
    return transaction.signMessage(claim, secret)
}

const verifyClaim = (claim, signature, publicKey) => {
    return transaction.verify(claim, signature, publicKey)
}

const submitClaim = (Account, Amount, Balance, Channel, PublicKey, Signature, Fee, Sequence, secret, callback, error) => {
    const object = transaction.paymentChannel_claim(Account, Amount, Balance, Channel, PublicKey, Signature, Fee, Sequence)
    const blob = transaction.signTX(object, secret).signedTransaction
    var tx = {
        "method": "submit",
        "params": [
            {
                "tx_blob": blob
            }
        ]
    }
    submit(tx, callback, error)
}

const accountChannel = (account, destination_account) => {
    return transaction.account_channels(account, destination_account)
}

const accountInfo = (account) => {
    return {
        "method": "account_info",
        "params": [
            {
                "account": account,
                "strict": true,
                "ledger_index": "validated"
            }
        ]
    }
}

const submit = (tx, callback, error) => {
    axios.post(SERVER, tx)
        .then(function (response) {
            
            callback(response.data)
        })
        .catch(function (err) {
            error(err)
        });
}

var handler;
var handlerError;

handler = (obj) => {
    const engine_result = obj.result.engine_result
    const engine_result_message = obj.result.engine_result_message
    if (obj.result.engine_result == "tesSUCCESS") {
        console.log("success")
    } else {
        console.log("fail")
    }
    console.log("Ledger message " + engine_result_message + " " + engine_result)
}


handlerError = (error) => {
    console.log(error);
}

const keypair = (secret) => {
    return rippleKeyPairs.deriveKeypair(secret);
}

const getAddress = (publicKey) => {
    return rippleKeyPairs.deriveAddress(publicKey);
}

exports.createChannel = createChannel
exports.fundChannel = fundChannel
exports.closeChannel = closeChannel
exports.claim = claim
exports.signClaim = signClaim
exports.verifyClaim = verifyClaim
exports.submitClaim = submitClaim
exports.accountChannel = accountChannel
exports.accountInfo = accountInfo
exports.submit = submit
exports.handler = handler
exports.handlerError = handlerError
exports.keypair = keypair
exports.getAddress = getAddress