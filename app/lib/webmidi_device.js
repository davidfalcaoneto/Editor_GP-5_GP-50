"use strict";
/*
 * webmidi_device.js — read/select client for the GP-5 / GP-50 over WebMIDI.
 *
 * The browser-side twin of patch/live_read.py + patch/select_patch.py: same
 * CRC-8/0x07, same nibble framing, same reassembly. Proven byte-for-byte against
 * the Python path on live hardware (see re/DEVICE_READ.md, the WebMIDI section).
 *
 * READ + SELECT, plus one gated raw-send primitive (_sendStream) used only by
 * webmidi_write.js. All patch-write building/validation/gating lives there; this
 * module just owns the port + the one-at-a-time chain and refuses to move write
 * bytes without an explicit confirm+validated. A bad write can wedge the pedal
 * (power-cycle to recover), so that gate is load-bearing.
 *
 * Needs window.PRST (prst.js) for device profiles + rebuild(). Chrome/Edge only.
 *
 *   const dev = await WebMidiDevice.connect();      // {key,name}; throws if none
 *   const names = await WebMidiDevice.readNames();  // [{slot,name}, ...]
 *   await WebMidiDevice.selectSlot(7);              // SysEx 0x43 (non-destructive)
 *   const prst = await WebMidiDevice.readSlotPrst(7); // select + 0x41 + rebuild -> Uint8Array
 *
 * [Editor GP-5/GP-50] Tambem conecta pelo Bluetooth (connectBle, BLE-MIDI com o
 * mesmo protocolo SysEx) e repassa as mensagens espontaneas da pedaleira para
 * onUnsolicited. Ver os comentarios marcados com [Editor GP-5/GP-50].
 */
(function (root) {
  const PRST = root.PRST;
  const CATSEL = 0x12;
  const SEL_NAMES = 0x40;
  const SEL_BODY = 0x41;
  // Cadence, mirrored from live_read.py: the pedal has a shallow input queue and
  // wedges if requests outrun it. One at a time, settle after each.
  const POST_PC_MS = 300; // settle after a Program Change before reading
  const IDLE_MS = 400; // reply stream considered done after this much quiet
  const READ_TIMEOUT_MS = 2500;
  const SETTLE_MS = 200; // quiet gap after each request completes

  // --- SysEx codec (port of live_read.py) -----------------------------------
  function crc8(bytes) {
    let c = 0;
    for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; }
    return c;
  }
  function buildRequest(selector) {
    const buf = [0, 0x01, 0x00, 0x02, CATSEL, selector];
    buf[0] = crc8(buf);
    return buf;
  }
  const toWire = (buf) => buf.flatMap((b) => [b >> 4, b & 0xf]);
  const nibDecode = (arr) => {
    const out = [];
    for (let i = 0; i + 1 < arr.length; i += 2) out.push((arr[i] << 4) | arr[i + 1]);
    return out;
  };
  function reassemble(replies) {
    const byCmd = new Map();
    for (const b of replies) {
      if (b.length < 4) continue;
      if (!byCmd.has(b[1])) byCmd.set(b[1], []);
      byCmd.get(b[1]).push([b[2], b.slice(4)]);
    }
    const out = new Map();
    for (const [cmd, chunks] of byCmd) {
      chunks.sort((a, z) => a[0] - z[0]);
      out.set(cmd, chunks.flatMap((c) => c[1]));
    }
    return out;
  }
  function splitNames(blob, hdr = 2, rec = 20) {
    const names = [];
    const dv = new DataView(new Uint8Array(blob).buffer);
    for (let i = hdr; i + rec <= blob.length; i += rec) {
      const idx = dv.getUint32(i, true);
      let nm = "";
      for (let j = i + 4; j < i + rec; j++) { if (blob[j] === 0) break; nm += String.fromCharCode(blob[j]); }
      names.push({ slot: idx, name: nm.trim() });
    }
    return names;
  }

  // GP-50 first so the "GP-5" substring can't shadow it.
  const findPort = (map) => {
    const ports = [...map.values()];
    return ports.find((p) => (p.name || "").includes("GP-50"))
      || ports.find((p) => (p.name || "").includes("GP-5")) || null;
  };
  const profileForPort = (name) =>
    (name || "").includes("GP-50") ? PRST.GP50 : PRST.GP5;

  // --- connection state ------------------------------------------------------
  let access = null, input = null, output = null, profile = null;
  let namesCache = null;
  let chain = Promise.resolve(); // serializes all device requests (one at a time)

  // [Editor GP-5/GP-50] Transporte: USB (Web MIDI) ou Bluetooth (Web Bluetooth).
  // `io` = {kind, label, send(msg), close()}. Tudo que chega da pedaleira passa por
  // dispatch(): vai para `listener` (a troca pedido/resposta em andamento) ou, se
  // nao houver nenhuma, para passive() — mensagens que a pedaleira manda sozinha.
  let io = null, listener = null, lastTx = 0;
  const dispatch = (msg) => (listener ? listener(msg) : passive(msg));
  function send(msg) {
    lastTx = performance.now();
    const r = io.send(msg);
    if (r && r.catch) r.catch((e) => console.error("[pedaleira] falha ao enviar", e));
  }

  function assertReady() {
    if (!io) throw new Error("not connected — call WebMidiDevice.connect() first");
    if (!root.PRST) throw new Error("prst.js (window.PRST) is not loaded");
  }

  // [Editor GP-5/GP-50] Bluetooth: a pedaleira expoe o servico BLE-MIDI padrao e
  // fala o MESMO protocolo SysEx do USB, embrulhado em pacotes BLE-MIDI. Formato
  // de envio igual ao do gp5-wc, que funciona na GP-5: 80 80 F0 ... F7 (timestamp
  // zero, sem timestamp antes do F7). As notificacoes chegam no mesmo formato.
  const BLE_MIDI_SERVICE = "03b80e5a-ede8-4b33-a751-6ce34ec4c700";
  const BLE_MIDI_CHAR = "7772e5db-3868-4112-a1a9-f2669d106bf3";
  const BLE_PACKET_MAX = 100; // bytes por escrita; nossa maior mensagem tem ~50

  function bleEncode(msg) {
    const out = [[0x80, 0x80, ...msg.slice(0, BLE_PACKET_MAX - 2)]];
    for (let i = BLE_PACKET_MAX - 2; i < msg.length; i += BLE_PACKET_MAX - 1) out.push([0x80, ...msg.slice(i, i + BLE_PACKET_MAX - 1)]);
    return out;
  }

  // Pacote BLE-MIDI -> mensagens MIDI. bytes[0] e o cabecalho; um byte >= 0x80
  // seguido de outro >= 0x80 e timestamp + status. Os dados da SysEx da pedaleira
  // sao nibbles (< 0x10), entao nunca se confundem com timestamp.
  let bleSysex = null;
  function bleDecode(bytes, emit) {
    for (let i = 1; i < bytes.length; i++) {
      const b = bytes[i], next = bytes[i + 1];
      if (b < 0x80) { if (bleSysex) bleSysex.push(b); continue; }
      if (bleSysex && next === 0xf7) { emit([...bleSysex, 0xf7]); bleSysex = null; i++; continue; } // timestamp + F7
      if (bleSysex && b === 0xf7) { emit([...bleSysex, 0xf7]); bleSysex = null; continue; } // F7 sem timestamp
      let s = b;
      if (next >= 0x80) { s = next; i++; }
      if (s === 0xf0) bleSysex = [0xf0];
      else if (s < 0xf0) {
        const n = (s & 0xe0) === 0xc0 ? 1 : 2;
        emit([s, ...bytes.slice(i + 1, i + 1 + n)]);
        i += n;
      }
    }
  }

  // [Editor GP-5/GP-50] Mensagens espontaneas da pedaleira (troca de preset ou knob
  // mexido no proprio aparelho). Entrega {raw, cmd?, payload?, program?, ownEcho}
  // para onUnsolicited; ownEcho = chegou logo depois de um comando nosso.
  const QUIET_AFTER_TX_MS = 600;
  function passive(msg) {
    const ev = { raw: msg, ownEcho: performance.now() - lastTx < QUIET_AFTER_TX_MS };
    if (msg[0] === 0xf0 && msg[msg.length - 1] === 0xf7) {
      const buf = nibDecode(msg.slice(1, -1));
      if (buf.length >= 4 && crc8(buf.slice(1)) === buf[0]) { ev.cmd = buf[1]; ev.payload = buf.slice(4, 4 + buf[3]); }
    } else if ((msg[0] & 0xf0) === 0xc0) ev.program = msg[1];
    const api = root.WebMidiDevice;
    if (api && api.onUnsolicited) api.onUnsolicited(ev);
  }

  function lost() {
    if (!io) return;
    io = listener = input = output = access = profile = namesCache = null;
    bleSysex = null;
    const api = root.WebMidiDevice;
    if (api && api.onDisconnect) api.onDisconnect();
  }

  // Run `fn` after every previously-queued request has finished + settled.
  function serialize(fn, settleMs = SETTLE_MS) {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => new Promise((r) => setTimeout(r, settleMs)),
      () => new Promise((r) => setTimeout(r, settleMs))
    );
    return run;
  }

  // One request/reply exchange: send `wire`, collect nibble-decoded SysEx frames
  // until the stream goes idle, reassemble, return the longest blob.
  function exchange(wire) {
    return new Promise((resolve, reject) => {
      const replies = [];
      listener = (d) => {
        if (d[0] === 0xf0 && d[d.length - 1] === 0xf7) replies.push(nibDecode(d.slice(1, -1)));
      };
      try { send(wire); }
      catch (err) { listener = null; return reject(err); }
      const t0 = performance.now(); let last = t0, seen = 0;
      const tick = () => {
        if (replies.length > seen) { seen = replies.length; last = performance.now(); }
        const now = performance.now();
        if (now - t0 > READ_TIMEOUT_MS || (seen > 0 && now - last > IDLE_MS)) {
          listener = null;
          const banks = reassemble(replies);
          const blob = [...banks.values()].sort((a, z) => z.length - a.length)[0] || [];
          return resolve({ blob, frames: replies.length });
        }
        setTimeout(tick, 25);
      };
      tick();
    });
  }

  async function connect() {
    if (!navigator.requestMIDIAccess) throw new Error("this browser has no WebMIDI (use Chrome or Edge)");
    if (io) disconnect();
    access = await navigator.requestMIDIAccess({ sysex: true });
    input = findPort(access.inputs);
    output = findPort(access.outputs);
    if (!input || !output) throw new Error("no GP-5 / GP-50 MIDI port found — connect it and close Valeton Suite");
    profile = profileForPort(input.name);
    namesCache = null;
    const inp = input;
    inp.onmidimessage = (e) => dispatch(Array.from(e.data));
    access.onstatechange = (e) => { if (e.port === inp && e.port.state === "disconnected") lost(); };
    io = { kind: "usb", label: "USB", send: (msg) => output.send(msg), close: () => { inp.onmidimessage = null; } };
    return { key: profile.key, name: profile.name, port: input.name, transport: io.label };
  }

  // [Editor GP-5/GP-50] Conecta pelo Bluetooth. O navegador mostra a lista de
  // aparelhos BLE-MIDI por perto. GP-5 ou GP-50: pelo nome anunciado e, se o nome
  // nao disser, pelo tamanho do preset ativo (cada modelo tem um tamanho).
  async function connectBle() {
    if (!navigator.bluetooth) throw new Error("este navegador não tem Web Bluetooth (use Chrome ou Edge)");
    const dev = await navigator.bluetooth.requestDevice({ filters: [{ services: [BLE_MIDI_SERVICE] }] });
    if (io) disconnect();
    const server = await dev.gatt.connect();
    const ch = await (await server.getPrimaryService(BLE_MIDI_SERVICE)).getCharacteristic(BLE_MIDI_CHAR);
    ch.addEventListener("characteristicvaluechanged", (e) => {
      const v = e.target.value;
      bleDecode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), dispatch);
    });
    await ch.startNotifications();
    const write = ch.properties.writeWithoutResponse ? (v) => ch.writeValueWithoutResponse(v) : (v) => ch.writeValue(v);
    let writes = Promise.resolve();
    const onGone = () => lost();
    dev.addEventListener("gattserverdisconnected", onGone);
    io = {
      kind: "ble", label: "Bluetooth",
      send: (msg) => {
        for (const p of bleEncode(msg)) writes = writes.catch(() => {}).then(() => write(Uint8Array.from(p)));
        return writes;
      },
      close: () => { dev.removeEventListener("gattserverdisconnected", onGone); if (dev.gatt.connected) dev.gatt.disconnect(); },
    };
    bleSysex = null; namesCache = null;
    const name = dev.name || "";
    profile = /GP-?50/i.test(name) ? PRST.GP50 : /GP-?5/i.test(name) ? PRST.GP5 : await probeProfile();
    return { key: profile.key, name: profile.name, port: name || "Bluetooth", transport: io.label };
  }

  function probeProfile() {
    return serialize(async () => {
      const { blob } = await exchange([0xf0, ...toWire(buildRequest(SEL_BODY)), 0xf7]);
      const len = blob[0] === CATSEL && blob[1] === SEL_BODY ? blob.length - 2 : blob.length;
      const p = Object.values(PRST.DEVICES).find((d) => PRST.bodyLen(d) === len);
      if (!p) { disconnect(); throw new Error(`aparelho Bluetooth não reconhecido como GP-5/GP-50 (resposta de ${len} bytes)`); }
      return p;
    });
  }

  function disconnect() {
    if (io) io.close();
    io = listener = input = output = access = profile = namesCache = null;
    bleSysex = null;
  }

  const isConnected = () => !!io;
  const device = () => (profile ? { key: profile.key, name: profile.name, transport: io ? io.label : "" } : null);

  function readNames() {
    assertReady();
    return serialize(async () => {
      const { blob } = await exchange([0xf0, ...toWire(buildRequest(SEL_NAMES)), 0xf7]);
      namesCache = splitNames(blob);
      return namesCache;
    });
  }

  // Read an arbitrary catalog selector (e.g. 0x24 SnapTone names, 0x20 User IR
  // names) and return the longest reassembled blob. Same transport as readNames.
  function readBankBlob(selector) {
    assertReady();
    return serialize(async () => (await exchange([0xf0, ...toWire(buildRequest(selector)), 0xf7])).blob);
  }

  // [Editor GP-5/GP-50] A GP-5 ignora Program Change pelo USB (testado 2026-10-29):
  // nela o preset e trocado pela SysEx de edicao [0x11, 0x43, slot] (a mesma do
  // gp5-wc), que o aparelho responde. A GP-50 aceita a mesma SysEx (ver selectSlot).
  function buildEdit(payload) {
    const buf = [0, 0x01, 0x00, payload.length, ...payload];
    buf[0] = crc8(buf);
    return [0xf0, ...toWire(buf), 0xf7];
  }
  const buildSelect = (slot) => buildEdit([0x11, 0x43, slot & 0x7f, 0x00, 0x00, 0x00]);

  // [Editor GP-5/GP-50] Edicao ao vivo do preset ativo (memoria de trabalho; nada
  // fica gravado ate salvar). Confirmado na GP-5 por USB em 2026-10-29:
  //   [0x11,0x47, bloco u32, bloco u32, fxid u32]  troca o modelo (params voltam ao padrao)
  //   [0x11,0x48, bloco u32, algId u32, float32]   muda um parametro
  //   [0x11,0x49, bloco u32, 0|1 u32]              liga/desliga o bloco
  // O aparelho responde cada um com um quadro curto; esperamos ele (ou 300 ms) e
  // seguimos com pausa curta, para os knobs responderem na hora.
  const LIVE_WAIT_MS = 300, LIVE_SETTLE_MS = 15;
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const f32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return [...b]; };
  function sendEdit(payload) {
    assertReady();
    return serialize(() => new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; listener = null; resolve(); } };
      listener = (d) => { if (d[0] === 0xf0) finish(); };
      send(buildEdit(payload));
      setTimeout(finish, LIVE_WAIT_MS);
    }), LIVE_SETTLE_MS);
  }
  // [Editor GP-5/GP-50] Outros comandos da memoria de trabalho, do editor rvalladares.com/gp5/gpeditor
  // (que funciona na GP-5 por Bluetooth e USB):
  //   [0x11,0x44, 10 bytes]                ordem da cadeia
  //   [0x11,0x42, 01 20 00 00, vol u32]    volume do preset
  //   [0x11,0x42, 02 20 04 00, bpm u32]    BPM do preset (usado na GP-50; na GP-5 ainda nao confirmado)
  //   [0x11,0x4a, slot u32, nome 10 bytes] SALVA a memoria de trabalho no slot, com o nome
  //   [0x11,0x4d, ctl, bloco, 0|1]         GP-5: bloco entra/sai do CTL
  //   [0x11,0x4d, ctl1 u32, ctl2 u32]      GP-50: as duas mascaras de CTL inteiras. O formato
  //                                        da GP-5 na GP-50 grava os bytes do comando nas
  //                                        mascaras (lixo). Testado na GP-50 por USB em 2026-11-09.
  const SAVE_NAME_LEN = 10;
  const live = {
    model: (blk, fxid) => sendEdit([0x11, 0x47, ...u32(blk), ...u32(blk), ...u32(fxid >>> 0)]),
    param: (blk, alg, value) => sendEdit([0x11, 0x48, ...u32(blk), ...u32(alg), ...f32(value)]),
    toggle: (blk, on) => sendEdit([0x11, 0x49, ...u32(blk), ...u32(on ? 1 : 0)]),
    order: (order) => sendEdit([0x11, 0x44, ...order.map((b) => b & 0x0f)]),
    volume: (v) => sendEdit([0x11, 0x42, 0x01, 0x20, 0x00, 0x00, ...u32(Math.round(v))]),
    bpm: (v) => sendEdit([0x11, 0x42, 0x02, 0x20, 0x04, 0x00, ...u32(Math.round(v))]),
    ctl: (fs, blk, on) => sendEdit([0x11, 0x4d, fs & 0xff, blk & 0xff, on ? 1 : 0]),
    ctlMasks: (masks) => sendEdit([0x11, 0x4d, ...u32(masks[0] >>> 0), ...u32(masks[1] >>> 0)]),
    save: (slot, name) => {
      const n = [...String(name).padEnd(SAVE_NAME_LEN, " ").slice(0, SAVE_NAME_LEN)].map((c) => c.charCodeAt(0) & 0x7f);
      return sendEdit([0x11, 0x4a, ...u32(slot), ...n]);
    },
  };

  function selectSlot(slot) {
    assertReady();
    if (!(slot >= 0 && slot <= 99)) throw new Error(`slot ${slot} out of range 0..99`);
    // SysEx [0x11, 0x43, slot] nas duas: a GP-5 ignora Program Change pelo USB, e na
    // GP-50 a SysEx funciona por USB (testado em 2026-11-09) e e o que o editor
    // rvalladares usa pelo Bluetooth.
    return serialize(async () => {
      await exchange(buildSelect(slot));
      await new Promise((r) => setTimeout(r, POST_PC_MS));
    });
  }

  // Read the CURRENTLY active patch body (0x41) and rebuild a .prst. `name` labels
  // the patch (the device body carries no name). One retry on a short/raced read.
  function readActivePrst(name = "") {
    assertReady();
    return serialize(async () => {
      const wire = [0xf0, ...toWire(buildRequest(SEL_BODY)), 0xf7];
      const strip = (blob) => (blob[0] === CATSEL && blob[1] === SEL_BODY ? blob.slice(2) : blob);
      const wantLen = PRST.bodyLen(profile);
      let body = strip((await exchange(wire)).blob);
      if (body.length !== wantLen) {
        await new Promise((r) => setTimeout(r, 400));
        body = strip((await exchange(wire)).blob);
      }
      if (body.length !== wantLen) {
        throw new Error(`body read landed ${body.length} bytes (expected ${wantLen})`);
      }
      return PRST.rebuild(name, body, profile);
    });
  }

  // Select slot `slot`, then read its body back as a .prst. Uses the cached name
  // from readNames() (fetched once if not already cached).
  async function readSlotPrst(slot) {
    assertReady();
    if (!namesCache) await readNames();
    const hit = (namesCache || []).find((n) => n.slot === slot);
    await selectSlot(slot);
    return readActivePrst(hit ? hit.name : `slot${slot}`);
  }

  // [Editor GP-5/GP-50] Slot ativo na pedaleira: pedido [0x12, 0x43], resposta
  // [0x12, 0x43, slot, ...] (o "request_current_patch_number" do gp5-wc).
  function readCurrentSlot() {
    assertReady();
    return serialize(async () => {
      const { blob } = await exchange([0xf0, ...toWire(buildRequest(0x43)), 0xf7]);
      return blob[0] === CATSEL && blob[1] === 0x43 && blob.length > 2 ? blob[2] : null;
    });
  }

  // Le o slot ativo e o preset na memoria de trabalho (com o nome guardado do slot).
  async function readActive() {
    const slot = await readCurrentSlot();
    if (!namesCache) await readNames();
    const hit = slot != null && (namesCache || []).find((n) => n.slot === slot);
    return { slot, bytes: await readActivePrst(hit ? hit.name : "") };
  }

  // Gated raw sender for a pre-built, pre-validated write stream. Owns the port
  // and the one-at-a-time chain, so writes can't race reads. All write gating
  // (build/validate/WRITE_VERIFIED/confirm) lives in webmidi_write.js; this just
  // refuses to move bytes without an explicit confirm+validated from that layer.
  // Paces like Suite: one block, wait for the device ACK (shallow queue), repeat.
  function _sendStream(packets, opts) {
    assertReady();
    const { confirm = false, validated = false, ackWaitMs = 150 } = opts || {};
    if (!(confirm && validated)) throw new Error("refusing to send: _sendStream requires confirm && validated");
    return serialize(async () => {
      let acks = 0, pending = 0;
      listener = (d) => { if (d[0] === 0xf0) pending++; };
      const wait = io.kind === "ble" ? Math.max(ackWaitMs, 400) : ackWaitMs; // [Editor] BLE tem mais latencia
      try {
        for (const w of packets) {
          const before = pending;
          send(w);
          const t0 = performance.now();
          while (performance.now() - t0 < wait && pending === before) {
            await new Promise((r) => setTimeout(r, 5));
          }
          if (pending > before) acks++;
        }
      } finally { listener = null; }
      return { sent: packets.length, acks };
    });
  }

  root.WebMidiDevice = {
    connect, connectBle, disconnect, transport: () => (io ? io.kind : null), SAVE_NAME_LEN,
    isConnected, device, readNames, readBankBlob, selectSlot, readActivePrst, readSlotPrst, readCurrentSlot, readActive, _sendStream, live,
    onUnsolicited: null, onDisconnect: null,
    // exposed for tests / the probe
    _codec: { crc8, buildRequest, toWire, nibDecode, reassemble, splitNames, findPort, bleEncode, bleDecode },
  };
})(typeof self !== "undefined" ? self : this);
