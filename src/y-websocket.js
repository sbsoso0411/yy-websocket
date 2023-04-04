/**
 * @module provider/websocket
 */

/* eslint-env browser */
import * as bc from 'lib0/broadcastchannel';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as idb from 'lib0/indexeddb.js';
import * as math from 'lib0/math';
import { Observable } from 'lib0/observable';
import * as time from 'lib0/time';
import * as url from 'lib0/url';
import * as authProtocol from 'y-protocols/auth';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs'; // eslint-disable-line

export const messageSync = 0
export const messageQueryAwareness = 3
export const messageAwareness = 1
export const messageAuth = 2
export const messageInit = 4
export const messageError = 500

/**
 *                       encoder,          decoder,          provider,          emitSynced, messageType
 * @type {Array<function(encoding.Encoder, decoding.Decoder, WebsocketProvider, boolean,    number):void>}
 */
const messageHandlers = []

messageHandlers[messageSync] = (
  encoder,
  decoder,
  provider,
  emitSynced,
  _messageType
) => {
  encoding.writeVarUint(encoder, messageSync)
  const syncMessageType = syncProtocol.readSyncMessage(
    decoder,
    encoder,
    provider.doc,
    provider
  )
  if (
    emitSynced && syncMessageType === syncProtocol.messageYjsSyncStep2 &&
    !provider.synced
  ) {
    provider.synced = true
  }
}

messageHandlers[messageQueryAwareness] = (
  encoder,
  _decoder,
  provider,
  _emitSynced,
  _messageType
) => {
  encoding.writeVarUint(encoder, messageAwareness)
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(
      provider.awareness,
      Array.from(provider.awareness.getStates().keys())
    )
  )
}

messageHandlers[messageAwareness] = (
  _encoder,
  decoder,
  provider,
  _emitSynced,
  _messageType
) => {
  awarenessProtocol.applyAwarenessUpdate(
    provider.awareness,
    decoding.readVarUint8Array(decoder),
    provider
  )
}

messageHandlers[messageAuth] = (
  _encoder,
  decoder,
  provider,
  _emitSynced,
  _messageType
) => {
  authProtocol.readAuthMessage(
    decoder,
    provider.doc,
    (_ydoc, reason) => permissionDeniedHandler(provider, reason)
  )
}

// @todo - this should depend on awareness.outdatedTime
const messageReconnectTimeout = 30000

/**
 * @param {WebsocketProvider} provider
 * @param {string} reason
 */
const permissionDeniedHandler = (provider, reason) =>
  console.warn(`Permission denied to access ${provider.url}.\n${reason}`)

/**
 * @param {WebsocketProvider} provider
 * @param {Uint8Array} buf
 * @param {boolean} emitSynced
 * @return {encoding.Encoder}
 */
const readMessage = (provider, buf, emitSynced) => {
  const decoder = decoding.createDecoder(buf)
  const encoder = encoding.createEncoder()
  const messageType = decoding.readVarUint(decoder)
  const messageHandler = provider.messageHandlers[messageType]
  if (/** @type {any} */ (messageHandler)) {
    messageHandler(encoder, decoder, provider, emitSynced, messageType)
  } else {
    console.error('Unable to compute message')
  }
  return encoder
}

/**
 * @param {WebsocketProvider} provider
 */
const setupWS = (provider) => {
  if (provider.shouldConnect && provider.ws === null) {
    const websocket = new provider._WS(provider.url)
    websocket.binaryType = 'arraybuffer'
    provider.ws = websocket
    provider.wsconnecting = true
    provider.wsconnected = false
    provider.synced = false

    websocket.onmessage = async (event) => {
      provider.wsLastMessageReceived = time.getUnixTime()

      const buf = new Uint8Array(event.data)
      const decoder = decoding.createDecoder(buf)
      const messageType = decoding.readVarUint(decoder)
      /*-------- sb-yy-websocket change begin --------*/
      if (messageType === messageError) {
        const content = decoding.readVarUint8Array(decoder)
        const errorType = String.fromCharCode(...content)
        provider.emit('error', [errorType])
      } else if (messageType === messageInit) {
        const buf = new Uint8Array(event.data)
        buf[0] = messageSync

        const encoder = readMessage(provider, buf, false)
        if (encoding.length(encoder) > 1) {
          websocket.send(encoding.toUint8Array(encoder))
        }

        if (false) {
          // idb-persistence - disable
          try {
            const _db = await idb.openDB(provider.docId, (db) => { })
            if (_db.objectStoreNames.contains('updates')) {
              const [updatesStore] = idb.transact(_db, ['updates'])
              const updates = await idb.getAll(updatesStore)
              if (updates.length !== 0) {
                updates.forEach(update => {
                  const encoder = encoding.createEncoder()
                  encoding.writeVarUint(encoder, messageSync)
                  syncProtocol.writeUpdate(encoder, update)
                  const buf = encoding.toUint8Array(encoder)
                  broadcastMessage(provider, buf)
                })
                console.log('synced offline edits')
              }
            }
            await idb.deleteDB(provider.docId)
          } catch (err) {
            console.log('idb-persistence error', err)
          }
        }

        provider.emit('init', [])
      }
      /*-------- sb-yy-websocket change end --------*/
      else {
        const encoder = readMessage(provider, new Uint8Array(event.data), true)
        if (encoding.length(encoder) > 1) {
          websocket.send(encoding.toUint8Array(encoder))
        }
      }
    }
    websocket.onerror = (event) => {
      provider.emit('connection-error', [event, provider])
    }
    websocket.onclose = (event) => {
      provider.emit('connection-close', [event, provider])
      provider.ws = null
      provider.wsconnecting = false
      if (provider.wsconnected) {
        provider.wsconnected = false
        provider.synced = false
        // update awareness (all users except local left)
        awarenessProtocol.removeAwarenessStates(
          provider.awareness,
          Array.from(provider.awareness.getStates().keys()).filter((client) =>
            client !== provider.doc.clientID
          ),
          provider
        )
        provider.emit('status', [{
          status: 'disconnected'
        }])
      } else {
        provider.wsUnsuccessfulReconnects++
      }
      // Start with no reconnect timeout and increase timeout by
      // using exponential backoff starting with 100ms
      setTimeout(
        setupWS,
        math.min(
          math.pow(2, provider.wsUnsuccessfulReconnects) * 100,
          provider.maxBackoffTime
        ),
        provider
      )
    }
    websocket.onopen = async () => {
      provider.wsLastMessageReceived = time.getUnixTime()
      provider.wsconnecting = false
      provider.wsconnected = true
      provider.wsUnsuccessfulReconnects = 0
      provider.emit('status', [{
        status: 'connected'
      }])

      /*-------- sb-yy-websocket change begin --------*/
      // idb-persistence - disable
      /**
       * @type {Uint8Array | undefined}
       */
      let offlineEdit = undefined
      try {
        const _db = await idb.openDB(provider.docId, (db) => { })
        if (_db.objectStoreNames.contains('updates')) {
          const [updatesStore] = idb.transact(_db, ['updates'])
          const offlineEdits = await idb.getAll(updatesStore)
          // sync offline edits
          const offDoc = new Y.Doc()
          offDoc.transact(() => {
            offlineEdits.map(_offlineEdit => {
              Y.applyUpdate(offDoc, _offlineEdit)
            })
          })
          offlineEdit = Y.encodeStateAsUpdate(offDoc)
        }
        await idb.deleteDB(provider.docId)
      } catch (err) {
        console.log('idb-persistence error', err)
      }
      // send auth message when the socket is connected to the yjs-server
      provider.sendAuthToken(offlineEdit)
      /*-------- sb-yy-websocket change end --------*/

      // always send sync step 1 when connected
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageSync)
      syncProtocol.writeSyncStep1(encoder, provider.doc)
      websocket.send(encoding.toUint8Array(encoder))
      // broadcast local awareness state
      if (provider.awareness.getLocalState() !== null) {
        const encoderAwarenessState = encoding.createEncoder()
        encoding.writeVarUint(encoderAwarenessState, messageAwareness)
        encoding.writeVarUint8Array(
          encoderAwarenessState,
          awarenessProtocol.encodeAwarenessUpdate(provider.awareness, [
            provider.doc.clientID
          ])
        )
        websocket.send(encoding.toUint8Array(encoderAwarenessState))
      }
    }
    provider.emit('status', [{
      status: 'connecting'
    }])
  }
}

/**
 * @param {WebsocketProvider} provider
 * @param {ArrayBuffer} buf
 */
const broadcastMessage = (provider, buf) => {
  const ws = provider.ws
  if (provider.wsconnected && ws && ws.readyState === ws.OPEN) {
    ws.send(buf)
  }
  if (provider.bcconnected) {
    bc.publish(provider.bcChannel, buf, provider)
  }
}

/**
 * Websocket Provider for Yjs. Creates a websocket connection to sync the shared document.
 * The document name is attached to the provided url. I.e. the following example
 * creates a websocket connection to http://localhost:1234/my-document-name
 *
 * @example
 *   import * as Y from 'yjs'
 *   import { WebsocketProvider } from 'y-websocket'
 *   const doc = new Y.Doc()
 *   const provider = new WebsocketProvider('http://localhost:1234', 'my-document-name', doc)
 *
 * @extends {Observable<string>}
 */
export class WebsocketProvider extends Observable {
  /**
   * @param {string} serverUrl
   * @param {string} roomname
   * @param {Y.Doc} doc
   * @param {string} docId
   * @param {object} opts
   * @param {boolean} [opts.connect]
   * @param {awarenessProtocol.Awareness} [opts.awareness]
   * @param {Object<string,string>} [opts.params]
   * @param {typeof WebSocket} [opts.WebSocketPolyfill] Optionall provide a WebSocket polyfill
   * @param {number} [opts.resyncInterval] Request server state every `resyncInterval` milliseconds
   * @param {number} [opts.maxBackoffTime] Maximum amount of time to wait before trying to reconnect (we try to reconnect using exponential backoff)
   * @param {boolean} [opts.disableBc] Disable cross-tab BroadcastChannel communication
   */
  constructor(serverUrl, roomname, doc, docId, {
    connect = true,
    awareness = new awarenessProtocol.Awareness(doc),
    params = {},
    WebSocketPolyfill = WebSocket,
    resyncInterval = -1,
    maxBackoffTime = 2500,
    disableBc = false
  } = {}) {
    super()

    // ensure that url is always ends with /
    while (serverUrl[serverUrl.length - 1] === '/') {
      serverUrl = serverUrl.slice(0, serverUrl.length - 1)
    }
    const encodedParams = url.encodeQueryParams(params)
    this.maxBackoffTime = maxBackoffTime
    this.bcChannel = serverUrl + '/' + roomname
    this.url = serverUrl + '/' + roomname +
      (encodedParams.length === 0 ? '' : '?' + encodedParams)
    this.roomname = roomname
    this.doc = doc
    this.docId = docId
    this._WS = WebSocketPolyfill
    this.awareness = awareness
    this.wsconnected = false
    this.wsconnecting = false
    this.bcconnected = false
    this.disableBc = disableBc
    this.wsUnsuccessfulReconnects = 0
    this.messageHandlers = messageHandlers.slice()
    /**
     * @type {boolean}
     */
    this._synced = false
    /**
     * @type {WebSocket?}
     */
    this.ws = null
    this.wsLastMessageReceived = 0
    /**
     * Whether to connect to other peers or not
     * @type {boolean}
     */
    this.shouldConnect = connect

    /**
     * @type {number}
     */
    this._resyncInterval = 0
    if (resyncInterval > 0) {
      this._resyncInterval = /** @type {any} */ (setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          // resend sync step 1
          const encoder = encoding.createEncoder()
          encoding.writeVarUint(encoder, messageSync)
          syncProtocol.writeSyncStep1(encoder, doc)
          this.ws.send(encoding.toUint8Array(encoder))
        }
      }, resyncInterval))
    }

    /**
     * @param {ArrayBuffer} data
     * @param {any} origin
     */
    this._bcSubscriber = (data, origin) => {
      if (origin !== this) {
        const encoder = readMessage(this, new Uint8Array(data), false)
        if (encoding.length(encoder) > 1) {
          bc.publish(this.bcChannel, encoding.toUint8Array(encoder), this)
        }
      }
    }
    /**
     * Listens to Yjs updates and sends them to remote peers (ws and broadcastchannel)
     * @param {Uint8Array} update
     * @param {any} origin
     */
    this._updateHandler = (update, origin) => {
      if (origin !== this) {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, messageSync)
        syncProtocol.writeUpdate(encoder, update)
        const buf = encoding.toUint8Array(encoder)
        broadcastMessage(this, buf)
      }
    }
    this.doc.on('update', this._updateHandler)
    /**
     * @param {any} changed
     * @param {any} _origin
     */
    this._awarenessUpdateHandler = ({ added, updated, removed }, _origin) => {
      const changedClients = added.concat(updated).concat(removed)
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
      )
      broadcastMessage(this, encoding.toUint8Array(encoder))
    }
    this._unloadHandler = () => {
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        [doc.clientID],
        'window unload'
      )
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('unload', this._unloadHandler)
    } else if (typeof process !== 'undefined') {
      process.on('exit', this._unloadHandler)
    }
    awareness.on('update', this._awarenessUpdateHandler)
    this._checkInterval = /** @type {any} */ (setInterval(() => {
      if (
        this.wsconnected &&
        messageReconnectTimeout <
        time.getUnixTime() - this.wsLastMessageReceived
      ) {
        // no message received in a long time - not even your own awareness
        // updates (which are updated every 15 seconds)
        /** @type {WebSocket} */ (this.ws).close()
      }
    }, messageReconnectTimeout / 10))
    if (connect) {
      this.connect()
    }
    /*-------- sb-yy-websocket change begin --------*/
    // add props to the WebSocketProvider for auth token handling
    /**
     * @type {string}
     */
    this._authToken = ''
    /**
     * @type {NodeJS.Timer | null}
     */
    this._authTokenInterval = null
    /*-------- sb-yy-websocket change end --------*/
  }

  /*-------- sb-yy-websocket change begin --------*/
  // get, set methods for private prop "_authToken"
  /**
   * @type {string}
   */
  get authToken() {
    return this._authToken
  }
  set authToken(token) {
    this._authToken = token
    // send auth token to the yjs-server when it's reset
    this.wsconnected && this.sendAuthToken()
  }
  /*-------- sb-yy-websocket change end --------*/

  /**
   * @type {boolean}
   */
  get synced() {
    return this._synced
  }
  set synced(state) {
    if (this._synced !== state) {
      this._synced = state
      this.emit('synced', [state])
      this.emit('sync', [state])
    }
  }

  /*-------- sb-yy-websocket change begin --------*/
  // method which sends "_authToken" to the yjs-server
  /**
   * @param {Uint8Array | undefined} [offlineEdit]
   */
  sendAuthToken(offlineEdit) {
    const token = this._authToken
    const tokenLength = token.length
    const numArr = []
    for (let i = 0; i < tokenLength; ++i) {
      numArr.push(token.charCodeAt(i))
    }

    const tokenLengthBuffer = Uint8Array.from([tokenLength])
    const tokenBuffer = Uint8Array.from(numArr)
    const offlineEditBuffer = Uint8Array.from(offlineEdit || [])
    const msgBuffer = Uint8Array.from(Array.prototype.concat(tokenLengthBuffer, tokenBuffer, offlineEditBuffer))

    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAuth)
    encoding.writeVarUint8Array(encoder, msgBuffer)
    const buffer = encoding.toUint8Array(encoder)

    this.ws?.send(buffer)
  }
  /*-------- sb-yy-websocket change end --------*/

  destroy() {
    /*-------- sb-yy-websocket change begin --------*/
    this._authTokenInterval && clearInterval(this._authTokenInterval)
    /*-------- sb-yy-websocket change end --------*/

    if (this._resyncInterval !== 0) {
      clearInterval(this._resyncInterval)
    }
    clearInterval(this._checkInterval)
    this.disconnect()
    if (typeof window !== 'undefined') {
      window.removeEventListener('unload', this._unloadHandler)
    } else if (typeof process !== 'undefined') {
      process.off('exit', this._unloadHandler)
    }
    this.awareness.off('update', this._awarenessUpdateHandler)
    this.doc.off('update', this._updateHandler)
    super.destroy()
  }

  connectBc() {
    if (this.disableBc) {
      return
    }
    if (!this.bcconnected) {
      bc.subscribe(this.bcChannel, this._bcSubscriber)
      this.bcconnected = true
    }
    // send sync step1 to bc
    // write sync step 1
    const encoderSync = encoding.createEncoder()
    encoding.writeVarUint(encoderSync, messageSync)
    syncProtocol.writeSyncStep1(encoderSync, this.doc)
    bc.publish(this.bcChannel, encoding.toUint8Array(encoderSync), this)
    // broadcast local state
    const encoderState = encoding.createEncoder()
    encoding.writeVarUint(encoderState, messageSync)
    syncProtocol.writeSyncStep2(encoderState, this.doc)
    bc.publish(this.bcChannel, encoding.toUint8Array(encoderState), this)
    // write queryAwareness
    const encoderAwarenessQuery = encoding.createEncoder()
    encoding.writeVarUint(encoderAwarenessQuery, messageQueryAwareness)
    bc.publish(
      this.bcChannel,
      encoding.toUint8Array(encoderAwarenessQuery),
      this
    )
    // broadcast local awareness state
    const encoderAwarenessState = encoding.createEncoder()
    encoding.writeVarUint(encoderAwarenessState, messageAwareness)
    encoding.writeVarUint8Array(
      encoderAwarenessState,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
        this.doc.clientID
      ])
    )
    bc.publish(
      this.bcChannel,
      encoding.toUint8Array(encoderAwarenessState),
      this
    )
  }

  disconnectBc() {
    // broadcast message with local awareness state set to null (indicating disconnect)
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
        this.doc.clientID
      ], new Map())
    )
    broadcastMessage(this, encoding.toUint8Array(encoder))
    if (this.bcconnected) {
      bc.unsubscribe(this.bcChannel, this._bcSubscriber)
      this.bcconnected = false
    }
  }

  disconnect() {
    this.shouldConnect = false
    this.disconnectBc()
    if (this.ws !== null) {
      this.ws.close()
    }
  }

  connect() {
    this.shouldConnect = true
    if (!this.wsconnected && this.ws === null) {
      setupWS(this)
      this.connectBc()
    }
  }
}
