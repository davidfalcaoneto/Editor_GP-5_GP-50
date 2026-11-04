// node tests/test_device.mjs — ao vivo, salvar e gravar contra a pedaleira simulada (tests/fake_pedal.js)
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const guitarra = join(here, "../..");
const src = (p) => readFileSync(join(here, p), "utf8");

function load() {
  const ctx = { console, setTimeout, clearTimeout, performance, navigator: {}, Buffer, atob };
  ctx.self = ctx;
  vm.createContext(ctx);
  for (const f of ["../app/lib/prst.js", "../app/lib/webmidi_device.js", "../app/lib/webmidi_write.js", "../app/js/preset.js", "../app/js/device.js", "fake_pedal.js"]) vm.runInContext(src(f), ctx);
  const ring = (f) => JSON.parse(src(`../app/data/${f}`));
  ctx.catalogs = { gp5: ctx.Preset.makeCatalog(ring("fxid_ring_gp5.json")), gp50: ctx.Preset.makeCatalog(ring("fxid_ring.json")) };
  return ctx;
}

// 100 slots da GP-5: os presets de fabrica nos slots do nome do arquivo, o resto vazio
function gp5Slots(ctx) {
  const blank = ctx.PRST.applyEdits(ctx.PRST.convert(ctx.PRST.blankPrst("gp50"), "gp5"), { name: "GP-5" });
  const slots = Array.from({ length: 100 }, () => blank);
  for (const f of readdirSync(join(guitarra, "gp5/Presets")).filter((f) => f.endsWith(".prst"))) {
    const m = /^(\d+)-/.exec(f);
    if (m) slots[Number(m[1])] = new Uint8Array(readFileSync(join(guitarra, "gp5/Presets", f)));
  }
  return slots;
}
const gp50File = (name) => new Uint8Array(readFileSync(join(guitarra, "gp50/Presets", readdirSync(join(guitarra, "gp50/Presets")).find((f) => f.startsWith(name)))));

async function connected(opts = {}) {
  const ctx = load();
  const pedal = ctx.FakePedal.create({ PRST: ctx.PRST, Preset: ctx.Preset, catalog: ctx.catalogs.gp5, slots: gp5Slots(ctx), activeSlot: 11, ...opts });
  ctx.navigator.bluetooth = pedal.bluetooth;
  const info = await ctx.Device.connect("ble");
  await ctx.Device.readNames();
  return { ctx, pedal, info, D: ctx.Device, P: ctx.Preset, R: ctx.PRST, cat: ctx.catalogs.gp5 };
}
const noDiff = (d, msg = "") => assert.equal(d.length, 0, `${msg} ${d.join("; ")}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("ok  ", name); };

await test("conecta e adota o preset ativo sem mandar nada", async () => {
  const { D, pedal, R, cat, P, info } = await connected();
  assert.equal(info.key, "gp5");
  const before = pedal.sent.filter((p) => p[0] === 0x11).length;
  const shown = await D.liveStart(null, null, cat);
  assert.equal(D.activeSlot(), 11);
  noDiff(P.diff(shown, pedal.store[11], cat, { name: false }));
  assert.equal(pedal.sent.filter((p) => p[0] === 0x11).length, before); // nenhuma edicao
});

await test("ao vivo: modelo, parametro, liga/desliga, ordem e volume chegam na memoria de trabalho", async () => {
  const { D, pedal, R, cat, P } = await connected();
  const base = await D.liveStart(null, 31, cat);
  assert.equal(pedal.active(), 31);
  let t = base;
  const dly = P.readBlock(t, 7).fxid, other = cat.models("DLY").find((m) => m.fxid !== dly);
  t = P.writeBlock(t, 7, { fxid: other.fxid, params: P.defaultParams(other) });
  t = P.writeBlock(t, 7, { values: { [other.params[0].algId]: 77 } });
  t = P.writeBlock(t, 2, { active: !P.readBlock(t, 2).active });
  t = R.applyEdits(t, { order: P.moveInOrder(R.readOrder(t), 8, 0), settings: { patch_vol: 73 } });
  const n = await D.liveSync(t);
  assert.ok(n >= 5, `mandou ${n}`);
  noDiff(P.diff(t, pedal.memory(), cat, { name: false }));
  noDiff(P.diff(base, pedal.store[31], cat, { name: false }), "o slot guardado nao muda sem salvar");
});

await test("CTL ao vivo e salvo no slot", async () => {
  const { D, pedal, R, cat, P } = await connected();
  const base = await D.liveStart(null, 22, cat);
  const t = P.writeCtl(base, 0, (1 << 7) | (1 << 8));
  await D.liveSync(t);
  assert.equal(P.readCtl(pedal.memory())[0], (1 << 7) | (1 << 8));
  assert.ok(pedal.sent.some((p) => p[0] === 0x11 && p[1] === 0x4d));
  await D.save(22, "CTL test");
  const r = await D.verify(22, R.applyEdits(t, { name: "CTL test" }), cat);
  assert.equal(r.verified, true, r.diff.join("; "));
});

await test("salvar (0x4A) grava a memoria de trabalho no slot com o nome", async () => {
  const { D, pedal, R, cat, P } = await connected();
  const base = await D.liveStart(null, 31, cat);
  const t = P.writeBlock(base, 3, { values: { 0: 12 } });
  await D.liveSync(t);
  await D.save(31, "Meu Timbre Longo");
  assert.equal(R.readName(pedal.store[31]), "Meu Timbre"); // 10 caracteres
  const r = await D.verify(31, R.applyEdits(t, { name: "Meu Timbre" }), cat);
  assert.equal(r.verified, true, r.diff.join("; "));
});

await test("gravar na GP-5 um preset de arquivo da GP-50 (caminho que falhava no slot 31)", async () => {
  const { D, pedal, R, cat, P } = await connected();
  const file = gp50File("31-");
  const r = await D.writeSlot(31, file, cat);
  assert.equal(r.method, "salvar (0x4A)");
  assert.equal(r.verified, true, r.diff.join("; "));
  noDiff(P.diff(R.convert(file, "gp5"), pedal.store[31], cat, { name: false }));
  assert.ok(!pedal.sent.some((p) => p[1] === 0x4f), "nao usa o fluxo 0x1D na GP-5");
});

await test("mudancas feitas na pedaleira chegam ao editor", async () => {
  const { D, pedal, cat } = await connected();
  await D.liveStart(null, 11, cat);
  const edits = [], changes = [];
  D.onPedalChange((r) => changes.push(r), () => {}, (e) => edits.push(e));
  await sleep(700); // passa a janela de eco do ultimo comando
  pedal.turnKnob(7, 0, 42);
  pedal.stomp(2, false);
  await sleep(50);
  assert.equal(edits.map((e) => e.type).join(), "param,toggle");
  assert.equal(Math.round(edits[0].value), 42);
  pedal.pressSlot(14);
  await sleep(2500);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].slot, 14);
});

console.log(`\n${passed} testes ok`);
