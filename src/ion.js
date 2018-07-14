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
    this.msgScanned = {}
    this.serialTxCache = []
    this.connected = false
    this.checkCurrentAddressTimer = null,
    this.peers = {}
    this.tickets = {}
    this.waitingForTicket = true
    window.peers = this.peers
  }

  ephemeralAddr() {
    var iota = this.iota
    var iotaSeed = tryteGen(this.prefix, tempKey(this.prefix, this.encryptionKey))
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

  getRandomIce() {
    var servers = [{
      urls: 'stun:stun.iptel.org:3478'
    }, {
      urls: 'stun:stun.ipfire.org:3478'
    }, {
      urls: 'stun:stun.phone.com:3478'
    }, {
      urls: 'stun:stun.xs4all.nl:3478'
    }, {
      urls: 'stun:stun1.l.google.com:19302'
    }, {
      urls: 'stun:stun2.l.google.com:19302'
    }, {
      urls: 'stun:stun3.l.google.com:19302'
    }, {
      urls: 'stun:stun.vodafone.ro:3478'
    }]
    var ret = [servers[Math.floor(Math.random() * (servers.length - 1))]]
    console.log('using stun: ', ret[0]);
    return ret
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
      trickle: false,
      config: {
        iceServers: this.getRandomIce()
      }
    })

    var handler = new PeerHandler(this, options.user)
    p.on('connect', handler.handleConnect.bind(handler))
    p.on('data', handler.handleData.bind(handler))
    p.on('signal', handler.handleSignal.bind(handler))
    p.on('error', handler.handleError.bind(handler))
    this.peers[options.user] = p
  }

  async waitForBundles() {
    var searchAddr = this.ephemeralAddr()
    var _this = this
    return new Promise(function(resolve, reject) {
      var fn = async () => {
        var searchValues = {
          addresses: [searchAddr]
        }
        var txs = await _this.findTransactionObjects(searchValues)
        var bundles = []
        for (var tx of txs) {
          if (tx.currentIndex === 0) {
            var bundle = await _this.getBundle(tx.hash)
            if (bundle != null) {
              bundles.push(bundle)
            }
          }
        }
        if (bundles.length > 0) {
          return resolve(bundles)
        }
        if (searchAddr === _this.address) {
          setTimeout(fn, 3000)
        } else {
          return resolve([])
        }
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
    if (this.checkCurrentAddressTimer !== null) {
      clearInterval(this.checkCurrentAddressTimer)
      this.checkCurrentAddressTimer = null;

      // Reset timer with now a minute extra
      this.checkCurrentAddressTimer = setInterval(this.checkCurrentAddress.bind(this), 60000)
    }
    var iota = this.iota
    var jsonEncrypted = JSON.parse(iota.utils.extractJson(bundle))
    var jsons = JSON.parse(this.decrypt(jsonEncrypted.enc))
    for (var json of jsons) {
      var jsonStr = JSON.stringify(json)
      if (this.msgScanned[jsonStr]) {
        continue
      }
      console.log('processBundle > msg', json);
      if (json.cmd === 'neg') {
        if (!this.peers[json.user]) {
          this.startPeer({ user: json.user, initiator: false })
        }
        this.peers[json.user].signal(json.data)
        this.msgScanned[jsonStr] = true
      } else if (json.cmd === "ticket") {
        this.tickets[json.tag] = json
        console.log('this.tickets.length', Object.keys(this.tickets).length);
        this.processTickets(this.tickets);
        this.msgScanned[jsonStr] = true
      }
    }
  }

  processTickets(tickets) {
    var _this = this
    Object.values(this.tickets)
      .filter(ticket => !_this.peers[ticket.tag] && ticket.tag !== _this.myTag)
      .forEach(ticket => _this.startPeer({ user: ticket.tag, initiator: true }))
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
        console.log('broadcastJson, json:', jsonStr, e, r);
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
    this.peers[user].send(msg);
  }

  broadcast(msg) {
    for(var k in this.peers) {
      this.peers[k].send(msg);
    }
  }

  stop() {
    this.addr = null
    this.checkingAnswers = false

    for(var k in this.peers) {
      this.peers[k].destroy()
    }
    this.peers = {}
  }

  async reset() {
    this.stop()
    await this.connect()
  }

  async connect() {
    var ticketJson = {
      tag: this.myTag,
      cmd: 'ticket'
    }
    await this.broadcastSecureJson(ticketJson)
    var _this = this
    var checkAnswer = () => {
      _this.waitForBundles().then(async (bundles) => {
        for (var bundle of bundles) {
          _this.processBundle(bundle)
        }
        if (_this.checkingAnswers) {
          setTimeout(checkAnswer, 500)
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
ION.version = "1.0.8"

export default ION
