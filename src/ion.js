var Peer = require('simple-peer')
var CryptoJS = require("crypto-js")
import tryteGen from './utils/tryteGen.js'
import tempKey from './utils/temp-key'
const nanoid = require('nanoid')
var EventEmitter = require('eventemitter3')

class PeerHandler {
  constructor(ion, user) {
    this.ion = ion
    this.user = user
    this.dataCache = []
    this.startRetrieving = false
  }

  log(...args) {
    console.log(`[PeerHandler::${this.user}]`, ...args)
  }

  flushCachedData() {
    if (this.dataCache.length > 0) {
      for (var data of this.dataCache) {
        this.ion.emit('data', {
          user: this.user,
          data
        });
      }
      this.dataCache.length = 0
    }
  }

  handleConnect() {
    this.connected = true;
    this.ion.emit('connect', {
      user: this.user
    });
    this.flushCachedData()
    this.startRetrieving = true
  }

  handleData(data) {
    data = data + ""
    if (this.startRetrieving) {
      this.ion.emit('data', {
        user: this.user,
        data
      })
    } else {
      this.dataCache.push(data)
    }
  }

  handleError(e) {
    this.ion.emit('error', {
      user: this.user,
      error: e
    })
  }

  handleClose() {
    this.log('Connection closed, destroying object...')
    this.ion.peers[this.user].destroy()
    delete this.ion.peers[this.user]
    delete this.ion.tickets[this.user]

    this.ion.emit('close', {
      user: this.user
    })
  }

  async handleSignal(data) {
    this.log('handleSignal', JSON.stringify(data));
    await this.ion.broadcastSecureJson({
      cmd: 'neg',
      user: this.user,
      data
    })
  }
}

class ION extends EventEmitter {
  constructor(iota, prefix, encryptionKey, myTag) {
    super()
    this.iota = iota
    this.myTag = myTag
    this.prefix = prefix
    this.encryptionKey = encryptionKey
    this.minWeightMagnitude = 9
    this.checkingAnswers = false
    this.depth = 5
    this.bundlesScanned = {}
    this.serialTxCache = []
    this.connected = false
    this.checkCurrentAddressTimer = null,
    this.peers = {}
    this.tickets = {}
    this.waitingForTicket = true
    this.genesisTimestamp = Math.round(+new Date() / 1000)
    this.iceServers = [{
      urls: 'stun:stun.xs4all.nl:3478'
    }, {
      urls: 'stun:stun1.l.google.com:19302'
    }, {
      urls: 'stun:stun2.l.google.com:19302'
    }, {
      urls: 'stun:stun.vodafone.ro:3478'
    }]
  }

  ephemeralAddr(offset = 0) {
    var iota = this.iota
    var iotaSeed = tryteGen(this.prefix, tempKey(this.prefix, this.encryptionKey, undefined, undefined, offset))
    var addr = iota.utils.addChecksum(iotaSeed)
    return addr
  }

  async getBundle(tailTx) {
    var iota = this.iota
    return new Promise(function(resolve, reject) {
      iota.api.getBundle(tailTx, (e, r) => {
        if (e) {
          reject(e)
        } else {
          resolve(r)
        }
      })
    })
  }

  async findTransactionObjects(searchValues) {
    var iota = this.iota
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

  startPeer(options) {
    const initiator = options.initiator
    console.log(`startPeer as ${options.user}. Initiator is ${options.initiator}...`);
    var p = new Peer({
      initiator,
      trickle: true,
      config: {
        iceServers: this.iceServers
      }
    })

    var handler = new PeerHandler(this, options.user)
    p.on('connect', handler.handleConnect.bind(handler))
    p.on('data', handler.handleData.bind(handler))
    p.on('signal', handler.handleSignal.bind(handler))
    p.on('error', handler.handleError.bind(handler))
    p.on('close', handler.handleClose.bind(handler))
    this.peers[options.user] = p
  }

  async waitForBundles() {
    var _this = this
    return new Promise(function(resolve, reject) {
      var fn = async () => {
        var searchValues = {
          addresses: [_this.ephemeralAddr(1), _this.ephemeralAddr()]
        }
        console.log('searchValues', searchValues.addresses.join(" "));
        var txs = await _this.findTransactionObjects(searchValues)
        var bundles = []
        for (var tx of txs) {
          if (tx.currentIndex === 0) {
            if(!_this.bundlesScanned[tx.bundle]) {
              var bundle = await _this.getBundle(tx.hash)
              if (bundle != null) {
                bundles.push(bundle)
                _this.bundlesScanned[tx.bundle] = true
              }
            }
          }
        }
        if (bundles.length > 0) {
          bundles.sort((a, b) => {
            return a[0].timestamp > b[0].timestamp
          })
          return resolve(bundles)
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

  processBundle(bundle) {
    if (bundle[0].tag.indexOf(this.myTag) === 0) {
      return;
    }
    if(bundle[0].timestamp < this.genesisTimestamp) {
      // Anything before we arrived will be ignored.
      return;
    }
    var iota = this.iota
    var jsonEncrypted = JSON.parse(iota.utils.extractJson(bundle))
    var jsonStr = this.decrypt(jsonEncrypted.enc)
    try {
      var jsons = JSON.parse(jsonStr)
    }
    catch (e) {
      console.error(`Error parsing decrypted JSON: '${jsonStr}'. Encrypted JSON was: ${JSON.stringify(jsonEncrypted)}`, e);
    }
    for (var json of jsons) {
      jsonStr = JSON.stringify(json)
      console.log(`processBundle[${ bundle[0].tag }] > msg`, json);
      if (json.cmd === 'neg') {
        if(json.user === this.myTag) {
          if (!this.peers[bundle[0].tag]) {
            this.startPeer({ user: bundle[0].tag, initiator: false })
          }
          this.peers[bundle[0].tag].signal(json.data)
        }
      } else if (json.cmd === "ticket") {
        this.tickets[json.tag] = json
        console.log('this.tickets.length', Object.keys(this.tickets).length);
        this.processTickets(this.tickets);
      }
    }
  }

  processTickets(tickets) {
    var _this = this
    Object.values(this.tickets)
      .filter(ticket => !_this.peers[ticket.tag] && ticket.tag !== _this.myTag)
      .forEach(ticket => {
        _this.startPeer({ user: ticket.tag, initiator: true })
      })
  }

  async flushSerialTxCache() {
    var jsonStr = JSON.stringify(this.serialTxCache)
    var jsonEncrypted = this.encrypt(jsonStr)
    this.serialTxCache.length = 0
    var iota = this.iota
    var seed = tryteGen(this.prefix, nanoid(128))
    var encryptedTrytes = iota.utils.toTrytes(JSON.stringify({
      enc: jsonEncrypted
    }))
    var transfers = [{
      tag: this.myTag,
      address: this.ephemeralAddr(),
      value: 0,
      message: encryptedTrytes
    }]

    var _this = this
    return new Promise(function(resolve, reject) {
      iota.api.sendTransfer(seed, _this.depth, _this.minWeightMagnitude, transfers, (e, r) => {
        if (e) {
          reject(e);
        } else {
          resolve(r);
        }
      });
    });
  }

  async broadcastSecureJson(json) {
    this.serialTxCache.push(json)
    if (this.flushSerialTxCacheTimer !== null) {
      clearTimeout(this.flushSerialTxCacheTimer)
    }
    var _this = this
    this.flushSerialTxCacheTimer = setTimeout(() => {
      _this.flushSerialTxCache().then()
    }, 1000)
  }

  send(user, msg) {
    try {
      this.peers[user].send(msg)
    }
    catch (e) {
      console.error(`Error (ignored) while sending '${msg}' to ${user}!)`, e);
    }
  }

  broadcast(msg) {
    for(var k in this.peers) {
      this.send(k, msg);
    }
  }

  stop() {
    this.addr = null
    this.checkingAnswers = false

    for(var key of Object.keys(this.peers)) {
      this.peers[key].destroy()
      delete this.peers[key]
      delete this.tickets[key]
    }
  }

  async reset() {
    this.stop()
    await this.connect()
  }

  async broadcastMyTicket() {
    var ticketJson = {
      tag: this.myTag,
      cmd: 'ticket'
    }
    await this.broadcastSecureJson(ticketJson)
  }

  async connect() {
    await this.broadcastMyTicket()
    var _this = this
    var checkAnswer = () => {
      _this.waitForBundles().then(async (bundles) => {
        for (var bundle of bundles) {
          _this.processBundle(bundle)
        }
        if (_this.checkingAnswers) {
          setTimeout(checkAnswer, 1000)
        }
      }).catch((e) => {
        console.error(`waitForBundles`, e);
      })
    }
    if (!this.checkingAnswers) {
      this.checkingAnswers = true
      checkAnswer()
    }
  }
}

ION.utils = {
  randomString(length = 16) {
    return nanoid(length)
  },
  randomTag() {
    return tryteGen("", nanoid(128), 27)
  }
}
ION.version = "1.0.9"

export default ION
