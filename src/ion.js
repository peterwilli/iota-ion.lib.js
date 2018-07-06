var Peer = require('simple-peer')
var CryptoJS = require("crypto-js")
import tryteGen from './utils/tryteGen.js'
import tempKey from './utils/temp-key'
const nanoid = require('nanoid')
var EventEmitter = require('eventemitter3')

class ION {
  constructor(iota, prefix, encryptionKey, myTag) {
    this.iota = iota
    this.myTag = myTag
    this.prefix = prefix
    this.encryptionKey = encryptionKey
    this.minWeightMagnitude = 9
    this.checkingAnswers = false
    this.depth = 5
    this.msgScanned = {}
    this.events = new EventEmitter()
    this.serialTxCache = []
    this.connected = false
    this.checkCurrentAddressTimer = null,
    this.tickets = []
    this.peer = null
    this.waitingForTicket = true
    this.dataCache = []
    this.startRetrieving = false
  }

  generateAddress() {
    var iota = this.iota
    var iotaSeed = tryteGen(this.prefix, tempKey(this.prefix, this.encryptionKey))
    var addr = iota.utils.addChecksum(iotaSeed)
    this.addr = iotaSeed
    return this.addr
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
    if(this.peer !== null) {
      console.warn('Tried to call startPeer while ION already started, ignoring...');
      return;
    }
    var defaultOptions = {
      initiator: false
    }
    options = Object.assign(defaultOptions, options)
    var { initiator } = options
    console.log('startPeer, initiator:', initiator);
    var p = new Peer({
      initiator,
      trickle: true,
      config: {
        iceServers: [{
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
        }]
      }
    })
    p.on('connect', this.handleConnect.bind(this));
    p.on('data', this.handleData.bind(this));

    var _this = this;
    p.on('signal', (signal) => {
      _this.handleSignal(signal).then((e, r) => {
        console.log('p => Signal', e, r);
      });
    });
    p.on('error', function(err) {
      console.error('peer error', err)
      _this.events.emit('error', err)
    })
    this.peer = p
  }

  async waitForBundles() {
    var searchAddr = this.addr
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
        if(bundles.length > 0) {
          return resolve(bundles)
        }
        if(searchAddr === _this.address) {
          setTimeout(fn, 3000)
        }
        else {
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
    if(this.checkCurrentAddressTimer !== null) {
      clearInterval(this.checkCurrentAddressTimer)
      this.checkCurrentAddressTimer = null;

      // Reset timer with now a minute extra
      this.checkCurrentAddressTimer = setInterval(this.checkCurrentAddress.bind(this), 60000)
    }
    var iota = this.iota
    var jsonEncrypted = JSON.parse(iota.utils.extractJson(bundle))
    var jsons = JSON.parse(this.decrypt(jsonEncrypted.enc))
    for(var json of jsons) {
      var jsonStr = JSON.stringify(json)
      if(this.msgScanned[jsonStr]) {
        continue
      }
      console.log('processBundle > msg', json);
      if (json.cmd === "neg") {
        if(this.peer !== null && !this.waitingForTicket) {
          this.peer.signal(json.data)
          this.msgScanned[jsonStr] = true
        }
      } else if (json.cmd === "ticket") {
        this.msgScanned[jsonStr] = true
        this.tickets.push(json)
        var uniqueTickets = this.getUniqueTickets()
        console.log('uniqueTickets.length', uniqueTickets.length);
        if (uniqueTickets.length === 2) {
          this.events.emit('connecting')
          this.waitingForTicket = false;
          this.processTickets();
        }
        else if(this.tickets.length > 2) {
          // TODO: figure out a way to move to a new address or filter our the stale tickets.
        }
      }
    }
  }

  getUniqueTickets() {
    var filteredTickets = {}
    for(var ticket of this.tickets) {
      filteredTickets[ticket.tag] = ticket
    }
    return Object.values(filteredTickets)
  }

  processTickets() {
    var tags = this.getUniqueTickets().map((o) => {
      return o.tag;
    }).sort();

    this.isInitiator = tags[0] === this.myTag;
    this.startPeer({ initiator: this.isInitiator })
  }

  handleData(data) {
    data = data + ""
    if(this.startRetrieving) {
      this.events.emit('data', data);
    }
    else {
      this.dataCache.push(data)
    }
  }

  async handleSignal(data) {
    console.log('handleSignal', JSON.stringify(data));
    await this.broadcastSecureJson({
      cmd: 'neg',
      data
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
      address: this.addr,
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
    if(this.flushSerialTxCacheTimer !== null) {
      clearTimeout(this.flushSerialTxCacheTimer)
    }
    var _this = this
    this.flushSerialTxCacheTimer = setTimeout(() => {
      _this.flushSerialTxCache().then()
    }, 1000)
  }

  flushCachedData() {
    if(this.dataCache.length > 0) {
      for(var data of this.dataCache) {
        this.events.emit('data', data);
      }
      this.dataCache.length = 0
    }
  }

  handleConnect() {
    this.connected = true;
    if(this.checkCurrentAddressTimer !== null) {
      clearInterval(this.checkCurrentAddressTimer)
      this.checkCurrentAddressTimer = null;
    }
    this.events.emit('connect');
  }

  send(msg) {
    this.peer.send(msg);
  }

  async checkCurrentAddress() {
    if (!this.connected) {
      // Check if new address is available
      if (this.addr !== this.generateAddress()) {
        console.warn('No connection yet, and we moved to a new address, reset and reconnect');
        // await this.reset();
        window.location.reload();
      }
    }
  }

  stop() {
    this.addr = null
    this.startRetrieving = false
    this.checkingAnswers = false
    if(this.checkCurrentAddressTimer !== null) {
      clearInterval(this.checkCurrentAddressTimer)
      this.checkCurrentAddressTimer = null;
    }

    if (this.peer !== null) {
      this.peer.destroy()
      this.peer = null
    }
  }

  async reset() {
    this.stop()
    await this.connect()
  }

  async connect() {
    if (!this.addr) {
      this.generateAddress()
    }
    console.log(`connect() using address: ${this.addr}`);
    if(this.checkCurrentAddressTimer === null) {
      this.checkCurrentAddressTimer = setInterval(this.checkCurrentAddress.bind(this), 1000)
    }
    var ticketJson = {
      tag: this.myTag,
      cmd: 'ticket'
    }
    this.tickets.push(ticketJson)
    await this.broadcastSecureJson(ticketJson)
    var _this = this
    var checkAnswer = () => {
      _this.waitForBundles().then(async (bundles) => {
        for(var bundle of bundles) {
          _this.processBundle(bundle)
        }
        if(_this.checkingAnswers) {
          setTimeout(checkAnswer, 500)
        }
      }).catch((e) => {
        console.error(`waitForBundles`, e);
      })
    }
    if(!this.checkingAnswers) {
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
