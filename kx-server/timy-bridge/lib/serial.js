// timy-bridge/lib/serial.js — the serial connection itself.
//
// Wraps `serialport` so that the rest of the bridge deals in lines, not
// buffers. The package is required LAZILY: the bridge folder may be present
// with its dependencies not yet installed, and that must produce a clear
// message on the Setup page rather than a stack trace at startup.
//
// Timy3 line settings (alge-timy-interface.md): 9600 baud, 8 data bits, no
// parity, 1 stop bit. Also set the Timy's own menu to match, and disable
// hardware handshake (interface > RS-232 > handshake > NO RTS-CTS) or the
// device can go silent over USB.

'use strict';
const { EventEmitter } = require('node:events');

const DEFAULT_BAUD = 9600;
const RECONNECT_MS = [1000, 2000, 5000, 10000, 15000];

/** Load serialport on demand. Throws a message meant for the operator. */
function loadSerialPort() {
  try {
    return require('serialport').SerialPort;
  } catch (e) {
    const err = new Error(
      'The serialport package is not installed. Run "npm install" inside the ' +
      'timy-bridge folder to enable Timy3 timing. Everything else in ' +
      'KX-Results works without it.');
    err.code = 'NO_SERIALPORT';
    err.cause = e;
    throw err;
  }
}

/**
 * Events: 'line' (string), 'open' ({path, baud}), 'close' (reason),
 *         'error' (Error), 'reconnecting' ({attempt, delay_ms}).
 */
class TimyConnection extends EventEmitter {
  constructor({ SerialPort = null } = {}) {
    super();
    this._SerialPort = SerialPort;      // injectable for tests / simulator
    this._port = null;
    this._buffer = '';
    this._target = null;                // { path, baud }
    this._attempt = 0;
    this._timer = null;
    this._closing = false;
  }

  get connected() { return !!this._port?.isOpen; }
  get target() { return this._target; }

  async open(path, baud = DEFAULT_BAUD) {
    await this.close();
    this._SerialPort ??= loadSerialPort();
    this._target = { path, baud };
    this._closing = false;
    this._attempt = 0;
    await this._connect();
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const { path, baud } = this._target;
      const port = new this._SerialPort(
        { path, baudRate: baud, dataBits: 8, parity: 'none', stopBits: 1, autoOpen: false });

      port.open(err => {
        if (err) { this._scheduleReconnect(err.message); return reject(err); }
        this._port = port;
        this._buffer = '';
        this._attempt = 0;
        this.emit('open', { path, baud });
        resolve();
      });

      port.on('data', chunk => this._ingest(chunk));
      port.on('error', err => this.emit('error', err));
      port.on('close', () => {
        this._port = null;
        this.emit('close', this._closing ? 'closed by request' : 'device disconnected');
        if (!this._closing) this._scheduleReconnect('device disconnected');
      });
    });
  }

  // The Timy terminates each record with CR; some setups add LF. Split on
  // either, keep the remainder — a record can arrive across two USB reads.
  _ingest(chunk) {
    this._buffer += chunk.toString('latin1');
    const parts = this._buffer.split(/\r\n|\r|\n/);
    this._buffer = parts.pop();
    for (const line of parts) if (line.trim()) this.emit('line', line);

    // Guard against a device that never sends a terminator (wrong baud rate
    // is the usual cause): don't grow a buffer forever.
    if (this._buffer.length > 4096) {
      this.emit('error', new Error(
        'No line terminator in 4 kB of data — check the baud rate on the Timy.'));
      this._buffer = '';
    }
  }

  _scheduleReconnect(reason) {
    if (this._closing || !this._target) return;
    const delay = RECONNECT_MS[Math.min(this._attempt, RECONNECT_MS.length - 1)];
    this._attempt++;
    this.emit('reconnecting', { attempt: this._attempt, delay_ms: delay, reason });
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._connect().catch(() => { /* _connect already scheduled the next try */ });
    }, delay);
  }

  close() {
    this._closing = true;
    clearTimeout(this._timer);
    const port = this._port;
    this._port = null;
    this._target = null;
    if (!port?.isOpen) return Promise.resolve();
    return new Promise(resolve => port.close(() => resolve()));
  }
}

module.exports = { TimyConnection, loadSerialPort, DEFAULT_BAUD };
