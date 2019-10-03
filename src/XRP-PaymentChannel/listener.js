const WebSocket = require('ws');
var TEST_NET_WS = "wss://s.altnet.rippletest.net:51233"
var exports = module.exports = {};

exports.startSocket = (address) => {
    let channel = {
        "command": "subscribe",
        "accounts": [address],
        "stream": ["transactions"]
    }
    const ws = new WebSocket(TEST_NET_WS);

    ws.on('open', function open() {
        console.log("new message")
        ws.send(JSON.stringify(channel));
    });

    ws.on('message', function incoming(data) {
        let json = JSON.parse(data)
        if(json.type == "transaction") {
            console.log(json);
        }
    });

}