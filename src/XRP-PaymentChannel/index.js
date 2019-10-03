const xrp = require("./XRP/xrp")

var exports = module.exports = {};

exports.open = (owner, recipient, value, delay, fee, callback, error) => {
  const tx = xrp.accountInfo(owner.address)
  xrp.submit(tx, (obj) => {
    var seq = obj.result.account_data.Sequence;
    //SettleDelay
    xrp.createChannel(owner.address, value, recipient, delay, owner.publicKey, seq, fee, owner.secret, (obj) => {
      const engine_result = obj.result.engine_result
      const engine_result_message = obj.result.engine_result_message
      if (obj.result.engine_result == "tesSUCCESS") {
        callback(obj)
      } else {
        error(obj.result.engine_result)
      }
      console.log("Ledger message " + engine_result_message + " " + engine_result)
    }, (err) => {
      error(err)
    })
  }, (err) => {
    error(err)
  })
}

exports.fund = (owner, channel, value, fee, callback, error) => {
  const tx = xrp.accountInfo(owner.address)
  xrp.submit(tx, (obj) => {
    var seq = obj.result.account_data.Sequence;
    xrp.fundChannel(owner.address, channel, value, fee, seq, owner.secret, (obj) => {
      const engine_result = obj.result.engine_result
      const engine_result_message = obj.result.engine_result_message
      if (obj.result.engine_result == "tesSUCCESS") {
        console.log("success")
        callback(obj)
      } else {
        console.log("fail")
        error(obj.result.engine_result)
      }
      console.log("Ledger message " + engine_result_message + " " + engine_result)
    }, (err) => {
      error(err)
    })
  }, (err) => {
    error(err)
  })
}

exports.claim = (owner, channel, value, signature, recipient, fee, callback, error) => {
  const tx = xrp.accountInfo(owner.address)
  xrp.submit(tx, (obj) => {
    var seq = obj.result.account_data.Sequence;
    const wallet = xrp.keypair(owner.secret)
    const channelTX = accountChannel(owner.address, recipient)
    xrp.submit(channelTX, (obj) => {
      obj.result.channels.forEach((ch) => {
        if (ch.channel_id == channel) {
          xrp.submitClaim(owner.address, value, ch.balance, channel, wallet.publicKey, signature, fee, seq, owner.secret, (obj) => {
            const engine_result = obj.result.engine_result
            const engine_result_message = obj.result.engine_result_message
            if (obj.result.engine_result == "tesSUCCESS") {
              console.log("success")
              callback(obj)
            } else {
              console.log("fail")
              error(obj.result.engine_result)
            }
            console.log("Ledger message " + engine_result_message + " " + engine_result)
          }, error)
        }
      });
    }, (error) => {

    })
  }, (error) => {

  })
}

exports.closeChannel = (owner, channel, fee, callback, error) => {
  const tx = xrp.accountInfo(owner.address)
  xrp.submit(tx, (obj) => {
    var seq = obj.result.account_data.Sequence;
    xrp.closeChannel(owner.address, channel, fee, seq, owner.secret, (obj) => {
      const engine_result = obj.result.engine_result
      const engine_result_message = obj.result.engine_result_message
      if (obj.result.engine_result == "tesSUCCESS") {
        console.log("success")
        callback(obj)
      } else {
        console.log("fail")
        error(obj.result.engine_result)
      }
      console.log("Ledger message " + engine_result_message + " " + engine_result)
    }, error)
  }, error)
}

exports.sign = (wallet, value, channel) => {
  var claim;
  var signature;
  var verified;

  let amount = (parseFloat(value) * 1000000)
  claim = xrp.claim(channel, parseInt(amount).toString())
  signature = xrp.signClaim(claim, wallet.secret)
  verified = xrp.verifyClaim(claim, signature, xrp.keypair(wallet.secret).publicKey)
  if (verified) {
    console.log("claim was verified")
    return signature
  }
}

exports.getXRPChannels = (address, recipient, callback, error) => {
  const channelTX = xrp.accountChannel(address, recipient)
  xrp.submit(channelTX, callback, error)
}

exports.keypair = xrp.keypair
exports.verifyClaim = xrp.verifyClaim
exports.getAddress = xrp.getAddress