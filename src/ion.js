var Peer = require('simple-peer')
var CryptoJS = require("crypto-js")
import iota from './iota.js'
import tryteGen from './utils/tryteGen.js'
import tempKey from './utils/temp-key'
const nanoid = require('nanoid')
var EventEmitter = require('eventemitter3')

export default class ION {
  constructor(prefix, encryptionKey, myTag) {
    this.myTag = myTag
    this.prefix = prefix
    this.encryptionKey = encryptionKey
    this.minWeightMagnitude = 9
    this.depth = 5
    this.txsScanned = {}
    this.events = new EventEmitter()
    this.serialTxCache = {}
  }

  generateAddress() {
    var iotaSeed = tryteGen(this.prefix, tempKey(this.prefix, this.encryptionKey))
    var addr = iota.utils.addChecksum(iotaSeed)
    this.addr = iotaSeed
    return this.addr
  }

  async findTransactionObjects(searchValues) {
    return new Promise(function(resolve, reject) {
      iota.api.findTransactionObjects(searchValues, (e, r) => {
        if (e) {
          reject(e)
        } else {
          resolve(r)
        }
      })
    })
  }

  encrypt(msg) {
    return CryptoJS.AES.encrypt(msg, this.encryptionKey).toString()
  }

  decrypt(msg) {
    return CryptoJS.AES.decrypt(msg, this.encryptionKey).toString(CryptoJS.enc.Utf8)
  }

  async startPeer(options) {
    var {
      initiator
    } = options
    var p = new Peer({
      initiator,
      trickle: false,
      reconnectTimer: 5000,
      config: {
        iceServers: [{
          urls: 'stun:stun1.l.google.com:19302'
        }, {
          urls: 'stun:stun2.l.google.com:19302'
        }, {
          urls: 'stun:stun3.l.google.com:19302'
        }]
      }
    })
    this.peer = p
    this.events.emit('peer-added')
    p.on('error', function(err) {
      console.error('peer error', err)
    })
  }

  async waitForAnswer() {
    var searchValues = {
      addresses: [this.addr]
    }
    var _this = this
    return new Promise(function(resolve, reject) {
      var fn = async () => {
        var txs = await _this.findTransactionObjects(searchValues)
        for (var tx of txs) {
          if (!_this.txsScanned[tx.hash]) {
            _this.txsScanned[tx.hash] = true
            return resolve(tx)
          }
        }
        setTimeout(fn, 3000)
      }
      setTimeout(fn, 3000)
    })
  }

  increaseTryte(trytes) {
    var setCharAt = (str, index, chr) => {
      if (index > str.length - 1) return str;
      return str.substr(0, index) + chr + str.substr(index + 1);
    }

    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ9"
    for (var i = 0; i < trytes.length; i++) {
      var nextChar = alphabet.indexOf(trytes[i]) + 1
      if (nextChar >= alphabet.length) {
        // We go outside alphabet, reset current to zero and increase the next
        trytes = setCharAt(trytes, i, alphabet[0])
      } else {
        trytes = setCharAt(trytes, i, alphabet[nextChar])
        break
      }
    }

    return trytes
  }

  processTx(tx) {
    var frag = tx.signatureMessageFragment
    var msg = iota.utils.fromTrytes(frag)
    if(msg.indexOf("start:") === 0) {
      // Start message
      this.serialTxCache[msg.tag] = {
        expect: parseInt(msg.split(":")[1]),
        cache: []
      }
      return;
    }
    var signal = null
    var curCache = this.serialTxCache[msg.tag]
    try {
      curCache.cache.push(msg)
      if(curCache.cache.length === curCache.expect) {
        // unwrap cache
        var totalMsg
      }
    } catch (e) {
      window.IONDebug = {
        decrypt: this.decrypt
      }
      console.error('Error parsing this message:', msg, frag)
    } finally {
      if (signal !== null) {
        console.log('processTx > signal', signal);
        this.peer.signal(signal)
      }
    }
  }

  async connect(options) {
    if (!this.addr) {
      this.generateAddress()
      console.log(`Using address: ${this.addr}`);
    }

    var searchValues = {
      addresses: [this.addr]
    }
    var txs = await this.findTransactionObjects(searchValues)
    // for(var tx of txs) {
    //   if(tx.tag.indexOf(this.myTag) === 0) {
    //     // If myself appears in any tx, we know 100% we already had this channel.
    //     // We increase the trytes by 1 so we can try again in a (hopefully clean) environment.
    //     console.warn(`Address ${this.addr} is tainted, shifting to ${this.increaseTryte(this.addr)}`);
    //     this.addr = this.increaseTryte(this.addr)
    //     return await this.connect(options)
    //   }
    // }
    this.startPeer({
      initiator: txs.length === 0
    })

    var _this = this
    var p = this.peer
    var checkAnswer = () => {
      _this.waitForAnswer().then((newTx) => {
        if (newTx.tag.indexOf(_this.myTag) !== 0) {
          _this.processTx(newTx)
        }
        setTimeout(checkAnswer, 500)
      })
    }
    checkAnswer()
    var seed = tryteGen(this.prefix, nanoid(128))
    p.on('signal', function(data) {
      var signalEncrypted = _this.encrypt(JSON.stringify(data))
      var encryptedMessage = iota.utils.toTrytes(atob(signalEncrypted))
      var transfers = []
      const maxMsgLen = 2187;
      const amountOfTxs = Math.ceil(encryptedMessage.length / maxMsgLen);
      transfers.push({
        tag: _this.myTag,
        address: _this.addr,
        value: 0,
        message: iota.utils.toTrytes("start:" + amountOfTxs)
      })
      for (var i = 0; i < amountOfTxs; i++) {
        transfers.push({
          tag: _this.myTag,
          address: _this.addr,
          value: 0,
          message: encryptedMessage.substring(i * maxMsgLen, Math.min(encryptedMessage.length, ((i + 1) * maxMsgLen)))
        })
      }
      console.log(`Sending ${transfers.length} transfers...`);
      iota.api.sendTransfer(seed, _this.depth, _this.minWeightMagnitude, transfers, (e, r) => {
        console.log('sent transfer', data, e, r);
      })
    })
  }
}
