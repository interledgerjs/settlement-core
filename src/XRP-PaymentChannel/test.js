const paymentchannel = require("./index")
const rippleKeyPairs = require("ripple-keypairs");

const listener = require("./listener")

const seeds = {
    alice: "sn4MszCCYYjFn5Vdvk851LppW9fdK",
    bob: "ssxp4ECtaVfX9xYU6DuSkv2vGYoxE"
}

const  createWallet = (secret) => {
    var keypair = rippleKeyPairs.deriveKeypair(secret)
    return{
        secret:secret,
        publicKey:keypair.publicKey,
        privateKey:keypair.publicKey,
        address:rippleKeyPairs.deriveAddress(keypair.publicKey)
    }
}
const alice = createWallet(seeds.alice)
const bob = createWallet(seeds.bob)
console.log(alice)
//listener.startSocket(alice.address)
const channelId = "4D8A76DA0CF23BD9F9481DE58A3F8BF1804649C8FFA5B3EB13BD590A79865341"
/*paymentchannel.open(alice, bob.address, "1000000", 60, "5000", (obj) => {
    //console.log(obj)
}, (error) => {
    //console.log(error)
})*/

/*paymentchannel.getXRPChannels(alice.address,bob.address,(obj) => {
    console.log(obj.result.channels)
},(error) => {
    console.log(error)
})

paymentchannel.fund(alice,channelId,"1000000","5000",(obj) => {
    console.log(obj)
},(error) => {
    console.log(error)
})*/

/*const signedClaim = paymentchannel.sign(alice,"0.0001",channelId)
const isVerified = paymentchannel.verifyClaim(signedClaim,alice.publicKey)

console.log("is verified "+ isVerified)
console.log(signedClaim)*/