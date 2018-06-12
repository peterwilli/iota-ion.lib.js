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
    this.connected = false
    this.checkCurrentAddressTimer = null,
    this.tickets = []
    this.peer = null
    this.waitingForTicket = true
    this.dataCache = []
    this.startRetrieving = false
  }

  generateAddress() {
    var iotaSeed = tryteGen(this.prefix, tempKey(this.prefix, this.encryptionKey))
    var addr = iota.utils.addChecksum(iotaSeed)
    this.addr = iotaSeed
    return this.addr
  }

  async getBundle(tailTx) {
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

  async stopPeer() {
    if (this.peer !== null) {
      this.peer.destroy()
      this.peer = null
    }
  }

  async startPeer(options) {
    var defaultOptions = {
      initiator: false
    }
    options = Object.assign(defaultOptions, options)
    var { initiator } = options
    console.log('startPeer, initiator:', initiator);
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
    })
    this.peer = p
  }

  async waitForBundle() {
    var searchValues = {
      addresses: [this.addr]
    }
    var _this = this
    return new Promise(function(resolve, reject) {
      var fn = async () => {
        var txs = await _this.findTransactionObjects(searchValues)
        for (var tx of txs) {
          if (!_this.txsScanned[tx.hash]) {
            if (tx.currentIndex === 0) {
              var bundle = await _this.getBundle(tx.hash)
              if (bundle != null) {
                return resolve(bundle)
              }
            }
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

  async processBundle(bundle) {
    var json = JSON.parse(iota.utils.extractJson(bundle))
    if (bundle[0].tag.indexOf(this.myTag) === 0) {
      return true;
    }
    console.log('processBundle > bundle', bundle, JSON.stringify(json));
    if (json.enc) {
      if(this.peer !== null && !this.waitingForTicket) {
        console.log('processBundle > json', json);
        var signal = this.decrypt(json.enc)
        console.log('processBundle > signal', signal);
        if (signal !== null) {
          this.peer.signal(signal)
        }
        return true;
      }
      else {
        return false;
      }
    } else if (json.ticket) {
      this.tickets.push(json)
      console.log('this.tickets.length', this.tickets.length);
      if (this.tickets.length === 2) {
        if(this.checkCurrentAddressTimer !== null) {
          clearInterval(this.checkCurrentAddressTimer)
          this.checkCurrentAddressTimer = null;
        }
        this.waitingForTicket = false;
        await this.processTickets();
      }
      else if(this.tickets.length > 2) {
        this.reset();
      }
    }
    return true;
  }

  async processTickets() {
    var tags = this.tickets.map((o) => {
      return o.tag;
    }).sort();

    var initiator = this.tickets.map((o) => {
      return o.ticket;
    }).reduce((acc, val) => {
      return acc + val;
    }) % tags.length;

    this.isInitiator = tags[initiator] === this.myTag;
    await this.startPeer({ initiator: this.isInitiator })
  }

  handleData(data) {
    if(this.startRetrieving) {
      this.events.emit('data', data);
    }
    else {
      this.dataCache.push(data)
    }
  }

  async handleSignal(data) {
    console.log('handleSignal', JSON.stringify(data));
    var signalEncrypted = this.encrypt(JSON.stringify(data))
    var encryptedMessage = iota.utils.toTrytes(JSON.stringify({
      enc: signalEncrypted
    }))
    var transfers = [{
      tag: this.myTag,
      address: this.addr,
      value: 0,
      message: encryptedMessage
    }]
    await this.sendTransfers(transfers);
  }

  async sendTransfers(transfers) {
    console.log('sendTransfer, transfers:', JSON.stringify(transfers));
    var seed = tryteGen(this.prefix, nanoid(128))
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
        this.reset();
      }
    }
  }

  async reset() {
    this.addr = null
    if (this.peer !== null) {
      this.peer.destroy()
      this.peer = null
    }
    await this.connect()
  }

  async connect() {
    if (!this.addr) {
      this.generateAddress()
      console.log(`Using address: ${this.addr}`);
    }
    this.checkCurrentAddressTimer = setInterval(this.checkCurrentAddress.bind(this), 1000)
    var ticketJson = {
      tag: this.myTag,
      ticket: Math.round(Math.random() * 9999)
    }
    this.tickets.push(ticketJson)
    var ticketMessage = iota.utils.toTrytes(JSON.stringify(ticketJson))
    var transfers = [{
      tag: this.myTag,
      address: this.addr,
      value: 0,
      message: ticketMessage
    }]
    await this.sendTransfers(transfers)
    var _this = this
    var checkAnswer = () => {
      _this.waitForBundle().then(async (bundle) => {
        if(bundle !== null) {
          var ret = await _this.processBundle(bundle)
          if(ret) {
            for(var b of bundle) {
              _this.txsScanned[b.hash] = true
            }
          }
        }
        setTimeout(checkAnswer, 500)
      })
    }
    checkAnswer()
  }
}
