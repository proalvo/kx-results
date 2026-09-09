// timy-bridge/lib/discovery.js — find the Timy3 among the machine's serial ports.
//
// The bridge never guesses silently. Every port found is returned with a
// confidence level and a human-readable reason, so the Chief of Scoring sees
// WHY a port was picked (or why it wasn't):
//
//   'timy'     — identified as an ALGE device by USB vendor/product id or by
//                the manufacturer string. Safe to connect automatically.
//   'possible' — a generic USB-to-serial adapter (FTDI, Prolific, Silabs,
//                CH340). A Timy3 on an RS232 cable looks exactly like this,
//                and so does every other adapter on the machine — so we
//                offer it but do not auto-connect.
//   'unknown'  — anything else: built-in COM ports, Bluetooth pairings, and
//                a Timy3 SIMULATOR on a virtual port. Still connectable on
//                request; that is the point of the "connect anyway" option.
//
// Recognition is deliberately data-driven (edit the tables, not the logic):
// ALGE could ship a new product id, and a simulator can be made to advertise
// whatever it likes.

'use strict';

// ALGE USB ids, from the vendor's own pyusb example (alge-timy-interface.md).
// 0x0c4a is ALGE-TIMING; the three product ids are Timy generations 1-3.
const ALGE_VENDOR_IDS = ['0c4a'];
const ALGE_PRODUCT_IDS = ['0889', '088a', '088b'];

// Bridge chips commonly found between a Timy3's RS232 port and a USB socket.
const USB_SERIAL_BRIDGES = {
  '0403': 'FTDI',
  '067b': 'Prolific',
  '10c4': 'Silicon Labs CP210x',
  '1a86': 'CH340/CH341',
  '2341': 'Arduino (often a simulator)',
};

const hex = v => (v == null ? null : String(v).toLowerCase().replace(/^0x/, '').padStart(4, '0'));

/**
 * Classify one entry from SerialPort.list().
 * @returns {{confidence: 'timy'|'possible'|'unknown', reason: string}}
 */
function classifyPort(port) {
  const vid = hex(port.vendorId);
  const pid = hex(port.productId);
  const maker = String(port.manufacturer ?? '');

  if (vid && ALGE_VENDOR_IDS.includes(vid)) {
    const known = pid && ALGE_PRODUCT_IDS.includes(pid);
    return {
      confidence: 'timy',
      reason: known
        ? `ALGE-TIMING device (USB ${vid}:${pid})`
        : `ALGE-TIMING vendor id ${vid}, unlisted product id ${pid} — probably a newer Timy`,
    };
  }
  if (/alge/i.test(maker)) {
    return { confidence: 'timy', reason: `manufacturer reports "${maker}"` };
  }
  if (vid && USB_SERIAL_BRIDGES[vid]) {
    return {
      confidence: 'possible',
      reason: `${USB_SERIAL_BRIDGES[vid]} USB-serial adapter — could be a Timy3 on an RS232 cable`,
    };
  }
  return {
    confidence: 'unknown',
    reason: maker ? `unidentified device from "${maker}"` : 'unidentified serial port',
  };
}

/** Short label for the port dropdown, e.g. "COM3 — ALGE-TIMING (0c4a:088b)". */
function labelFor(port) {
  const bits = [port.manufacturer, port.serialNumber].filter(Boolean);
  return bits.length ? `${port.path} — ${bits.join(' · ')}` : port.path;
}

/**
 * List every serial port with its classification, Timy candidates first.
 * `SerialPort` is injected so tests (and a --simulate run) need no hardware.
 */
async function listPorts(SerialPort) {
  const raw = await SerialPort.list();
  const rank = { timy: 0, possible: 1, unknown: 2 };
  return raw
    .map(p => {
      const { confidence, reason } = classifyPort(p);
      return {
        path: p.path,
        label: labelFor(p),
        manufacturer: p.manufacturer ?? null,
        serial_number: p.serialNumber ?? null,
        vendor_id: hex(p.vendorId),
        product_id: hex(p.productId),
        confidence,
        reason,
        // Everything is connectable. The UI uses `confidence` to decide how
        // loudly to warn, not whether to offer the port at all.
        connectable: true,
      };
    })
    .sort((a, b) => rank[a.confidence] - rank[b.confidence] || a.path.localeCompare(b.path));
}

/**
 * Which port should we open without asking?
 *
 * Only when exactly ONE port is identified as a Timy. Two Timys (or a Timy
 * plus a leftover pairing that also claims to be one) is an ambiguity the
 * operator must resolve — connecting to the wrong one would silently time
 * the wrong course.
 *
 * @returns {{port: object|null, reason: string}}
 */
function pickAutoConnect(ports) {
  const timys = ports.filter(p => p.confidence === 'timy');
  if (timys.length === 1) {
    return { port: timys[0], reason: `auto-connected: ${timys[0].reason}` };
  }
  if (timys.length > 1) {
    return { port: null, reason: `${timys.length} ALGE devices found — choose one` };
  }
  const possible = ports.filter(p => p.confidence === 'possible');
  return {
    port: null,
    reason: possible.length
      ? 'no Timy3 identified — choose a port to connect anyway (e.g. a simulator ' +
        'or a Timy3 on an RS232 adapter)'
      : 'no serial ports look like a Timy3 — choose a port to connect anyway',
  };
}

module.exports = {
  classifyPort, labelFor, listPorts, pickAutoConnect,
  ALGE_VENDOR_IDS, ALGE_PRODUCT_IDS, USB_SERIAL_BRIDGES,
};
