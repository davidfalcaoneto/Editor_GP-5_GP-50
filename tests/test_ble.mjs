// node tests/test_ble.mjs — transporte Bluetooth (BLE-MIDI) contra uma pedaleira simulada
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const lib = (f) => readFileSync(join(here, "../app/lib", f), "utf8");
const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s) => s.match(/../g).map((h) => parseInt(h, 16));

// ---- pedaleira simulada: recebe pacotes BLE-MIDI, responde como a GP-5 ----
function fakePedal(ctx, { name = "GP-5", activeSlot = 7 } = {}) {
  const C = () => ctx.WebMidiDevice._codec;
  const listeners = [], written = [];
  const frame = (cmd, index, payload) => {
    const buf = [0, cmd, index, payload.length, ...payload];
    buf[0] = C().crc8(buf.slice(1));
    return [0xf0, ...C().toWire(buf), 0xf7];
  };
  const notify = (msg, split = false) => {
    const pkts = split ? [[0x80, 0x80, ...msg.slice(0, 30)], [0x80, ...msg.slice(30, -1), 0x81, 0xf7]] : [[0x80, 0x80, ...msg]];
    for (const p of pkts) setTimeout(() => listeners.forEach((fn) => fn({ target: { value: new DataView(Uint8Array.from(p).buffer) } })), 5);
  };
  const names = [];
  for (let i = 0; i < 100; i++) {
    const rec = [i, 0, 0, 0, ...[...`Preset ${i}`.padEnd(16, "\0")].map((c) => c.charCodeAt(0))];
    names.push(...rec);
  }
  const ch = {
    properties: { writeWithoutResponse: true },
    addEventListener: (_, fn) => listeners.push(fn),
    startNotifications: async () => {},
    writeValueWithoutResponse: async (v) => {
      const pkt = [...v]; written.push(pkt);
      const out = [];
      C().bleDecode(pkt, (m) => out.push(m));
      for (const m of out) {
        const buf = C().nibDecode(m.slice(1, -1));
        const payload = buf.slice(4);
        if (payload[0] === 0x12 && payload[1] === 0x40) {
          const blob = [0x12, 0x40, ...names];
          for (let i = 0, k = 0; i < blob.length; i += 100, k++) notify(frame(0x01, k, blob.slice(i, i + 100)), k === 1);
        } else if (payload[0] === 0x12 && payload[1] === 0x43) notify(frame(0x01, 0, [0x12, 0x43, activeSlot, 0]));
      }
    },
  };
  const dev = {
    name, addEventListener() {}, removeEventListener() {},
    gatt: { connected: true, connect: async () => ({ getPrimaryService: async () => ({ getCharacteristic: async () => ch }) }), disconnect() {} },
  };
  return { written, notify, frame, bluetooth: { requestDevice: async () => dev } };
}

function load() {
  const ctx = { console, setTimeout, clearTimeout, performance, navigator: {} };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(lib("prst.js"), ctx);
  vm.runInContext(lib("webmidi_device.js"), ctx);
  return ctx;
}

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("ok  ", name); };

await test("pedido de nomes igual ao 'start_sync' do gp5-wc", () => {
  const C = load().WebMidiDevice._codec;
  const wire = [0xf0, ...C.toWire(C.buildRequest(0x40)), 0xf7];
  assert.equal(hex(C.bleEncode(wire)[0]), "8080f0000e00010000000201020400f7");
  assert.equal(hex(C.bleEncode([0xf0, ...C.toWire(C.buildRequest(0x43)), 0xf7])[0]), "8080f0000700010000000201020403f7");
});

await test("decodifica BLE-MIDI: F7 com e sem timestamp, pacote dividido, Program Change", () => {
  const C = load().WebMidiDevice._codec;
  const msgs = [];
  const emit = (m) => msgs.push(hex(m));
  C.bleDecode(unhex("8080f0000e00010000000201020400f7"), emit);
  C.bleDecode(unhex("8080f0010203"), emit);
  C.bleDecode(unhex("800405"), emit);
  C.bleDecode(unhex("80060781f7"), emit);
  C.bleDecode(unhex("8081c005"), emit);
  assert.deepEqual(msgs, ["f0000e00010000000201020400f7", "f0010203040506 07f7".replace(" ", ""), "c005"]);
});

await test("mensagem longa vira varios pacotes e volta igual", () => {
  const C = load().WebMidiDevice._codec;
  const msg = [0xf0, ...Array.from({ length: 250 }, (_, i) => i % 16), 0xf7];
  const pkts = C.bleEncode(msg);
  assert.ok(pkts.length > 1 && pkts.every((p) => p.length <= 100));
  const out = [];
  pkts.forEach((p) => C.bleDecode(p, (m) => out.push(m)));
  assert.deepEqual(out.map(hex), [hex(msg)]);
});

await test("conecta pelo Bluetooth, le nomes e slot ativo, recebe mudanca feita na pedaleira", async () => {
  const ctx = load();
  const pedal = fakePedal(ctx, { activeSlot: 42 });
  ctx.navigator.bluetooth = pedal.bluetooth;
  const D = ctx.WebMidiDevice;
  const info = await D.connectBle();
  assert.equal(info.key, "gp5");
  assert.equal(info.transport, "Bluetooth");
  const names = await D.readNames();
  assert.equal(names.length, 100);
  assert.equal(names[99].name, "Preset 99");
  assert.equal(await D.readCurrentSlot(), 42);
  // troca de preset pelo seletor `0x43` da GP-5: mesma SysEx do USB
  await D.selectSlot(5);
  assert.ok(pedal.written.some((p) => hex(p).startsWith("8080f0") && hex(p).includes("0101040300050000000000")));
  // mensagem espontanea (pedaleira trocou de preset sozinha)
  const got = [];
  D.onUnsolicited = (ev) => got.push(ev);
  await new Promise((r) => setTimeout(r, 700)); // passa a janela de "eco" do ultimo comando
  pedal.notify(pedal.frame(0x01, 0, [0x12, 0x43, 9, 0, 0, 0]));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(got.length, 1);
  assert.equal(got[0].ownEcho, false);
  assert.deepEqual([...got[0].payload], [0x12, 0x43, 9, 0, 0, 0]);
});

console.log(`\n${passed} testes ok`);
