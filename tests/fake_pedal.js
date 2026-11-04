"use strict";
/*
 * fake_pedal.js — GP-5/GP-50 simulada por Bluetooth (BLE-MIDI), para testes.
 *
 * Guarda 100 slots e a memoria de trabalho, responde aos pedidos de leitura
 * (0x40 nomes, 0x41 preset ativo, 0x43 slot ativo, 0x20/0x24 IRs e SnapTones) e
 * aplica os comandos de edicao (0x43 troca, 0x47 modelo, 0x48 parametro, 0x49
 * liga/desliga, 0x44 ordem, 0x42 volume/BPM, 0x4D CTL, 0x4A salvar). Imita o que se sabe
 * do aparelho; nao e o aparelho.
 *
 *   const pedal = FakePedal.create({ PRST, Preset, catalog, slots: [Uint8Array x100], name: "GP-5" });
 *   navigator.bluetooth = pedal.bluetooth;
 *   pedal.pressSlot(12)  // simula trocar de preset no aparelho
 *   pedal.turnKnob(7, 0, 42)
 */
(function (root) {
  function create({ PRST, Preset, catalog, slots, name = "GP-5", activeSlot = 0, log = () => {} }) {
    const crc8 = (bytes) => PRST.crc8(Uint8Array.from(bytes));
    const listeners = [];
    const store = slots.map((b) => Uint8Array.from(b));
    let memory = Uint8Array.from(store[activeSlot]), active = activeSlot;
    const sent = []; // comandos recebidos, decodificados: {payload}

    const toWire = (buf) => buf.flatMap((b) => [b >> 4, b & 0xf]);
    function frame(cmd, index, payload) {
      const buf = [0, cmd, index, payload.length, ...payload];
      buf[0] = crc8(buf.slice(1));
      return [0xf0, ...toWire(buf), 0xf7];
    }
    function notify(msg) {
      const pkt = Uint8Array.from([0x80, 0x80, ...msg]);
      setTimeout(() => listeners.forEach((fn) => fn({ target: { value: new DataView(pkt.buffer) } })), 3);
    }
    function reply(blob) { for (let i = 0, k = 0; i < blob.length; i += 100, k++) notify(frame(0x01, k, blob.slice(i, i + 100))); }
    const ack = () => notify(frame(0x01, 0, [0x14, 0x08]));
    const u32 = (p, i) => (p[i] | (p[i + 1] << 8) | (p[i + 2] << 16) | (p[i + 3] << 24)) >>> 0;
    const u32b = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    const f32 = (p, i) => new DataView(Uint8Array.from(p.slice(i, i + 4)).buffer).getFloat32(0, true);
    const f32b = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return [...b]; };

    function onRequest(sel) {
      if (sel === 0x40) {
        const recs = [];
        store.forEach((b, i) => recs.push(...u32b(i), ...[...PRST.readName(b).padEnd(16, "\0").slice(0, 16)].map((c) => c.charCodeAt(0))));
        return reply([0x12, 0x40, ...recs]);
      }
      if (sel === 0x41) return reply([0x12, 0x41, ...memory.subarray(PRST.BODY_OFF)]);
      if (sel === 0x43) return reply([0x12, 0x43, active, 0]);
      if (sel === 0x20) return reply([0x12, 0x20, ...Array.from({ length: 20 }, (_, i) => [...`User IR ${i + 1}`.padEnd(16, "\0")].map((c) => c.charCodeAt(0))).flat()]);
      if (sel === 0x24) {
        const occ = Array.from({ length: 80 }, (_, i) => (i < 50 ? 1 : 0));
        const names = Array.from({ length: 80 }, (_, i) => [...(i < 50 ? `Snap ${i}` : "").padEnd(16, "\0")].map((c) => c.charCodeAt(0))).flat();
        return reply([0x12, 0x24, ...occ, ...names]);
      }
    }
    function onEdit(p) {
      const op = p[1];
      if (op === 0x43) { active = p[2]; memory = Uint8Array.from(store[active]); }
      else if (op === 0x47) {
        const k = u32(p, 2), fxid = u32(p, 10);
        memory = Preset.writeBlock(memory, k, { fxid, params: Preset.defaultParams(catalog.get(fxid)) });
      } else if (op === 0x48) memory = Preset.writeBlock(memory, u32(p, 2), { values: { [u32(p, 6)]: f32(p, 10) } });
      else if (op === 0x49) memory = Preset.writeBlock(memory, u32(p, 2), { active: !!u32(p, 6) });
      else if (op === 0x44) memory = PRST.applyEdits(memory, { order: Array.from(p.slice(2, 12)) });
      else if (op === 0x42 && p[2] === 0x01) memory = PRST.applyEdits(memory, { settings: { patch_vol: u32(p, 6) } });
      else if (op === 0x42 && p[2] === 0x02) memory = PRST.applyEdits(memory, { settings: { bpm: u32(p, 6) } });
      else if (op === 0x4d) {
        const fs = p[2], k = p[3], m = Preset.readCtl(memory)[fs];
        memory = Preset.writeCtl(memory, fs, p[4] ? m | (1 << k) : m & ~(1 << k));
      } else if (op === 0x4a) {
        const slot = u32(p, 2), nm = String.fromCharCode(...p.slice(6, 16)).trim();
        store[slot] = PRST.applyEdits(memory, { name: nm });
        memory = Uint8Array.from(store[slot]);
      }
      ack();
    }

    const ch = {
      properties: { writeWithoutResponse: true, notify: true },
      addEventListener: (_, fn) => listeners.push(fn),
      startNotifications: async () => {},
      writeValueWithoutResponse: async (v) => {
        const bytes = [...v];
        if (bytes[2] !== 0xf0 || bytes[bytes.length - 1] !== 0xf7) return; // so mensagens inteiras (o editor manda assim)
        const mid = bytes.slice(3, -1), buf = [];
        for (let i = 0; i + 1 < mid.length; i += 2) buf.push((mid[i] << 4) | mid[i + 1]);
        const payload = buf.slice(4, 4 + buf[3]);
        sent.push(payload); log(payload);
        if (payload[0] === 0x12) onRequest(payload[1]);
        else if (payload[0] === 0x11) onEdit(payload);
      },
    };
    const device = {
      name, addEventListener() {}, removeEventListener() {},
      gatt: { connected: true, connect: async () => ({ getPrimaryService: async () => ({ getCharacteristic: async () => ch }) }), disconnect() {} },
    };
    return {
      bluetooth: { requestDevice: async () => device },
      store, sent,
      memory: () => memory, active: () => active,
      // acoes "no aparelho": avisam o editor como a pedaleira avisa
      pressSlot(slot) { active = slot; memory = Uint8Array.from(store[slot]); notify(frame(0x01, 0, [0x12, 0x43, slot, 0, 0, 0])); },
      turnKnob(k, alg, value) { memory = Preset.writeBlock(memory, k, { values: { [alg]: value } }); notify(frame(0x01, 0, [0x12, 0x48, ...u32b(k), ...u32b(alg), ...f32b(value)])); },
      stomp(k, on) { memory = Preset.writeBlock(memory, k, { active: on }); notify(frame(0x01, 0, [0x12, 0x49, ...u32b(k), ...u32b(on ? 1 : 0)])); },
    };
  }
  const API = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.FakePedal = API;
})(typeof self !== "undefined" ? self : this);
