// node tests/test_bulk.mjs — roda contra os presets reais em ..\gp5 e ..\gp50
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const PRST = require("../app/lib/prst.js");
const Preset = require("../app/js/preset.js");
const Bulk = require("../app/js/bulk.js");

const catalogs = {
  gp5: Preset.makeCatalog(JSON.parse(readFileSync(join(here, "../app/data/fxid_ring_gp5.json"), "utf8"))),
  gp50: Preset.makeCatalog(JSON.parse(readFileSync(join(here, "../app/data/fxid_ring.json"), "utf8"))),
};
const guitarra = join(here, "../..");
const load = (dir) => readdirSync(join(guitarra, dir)).filter((f) => f.endsWith(".prst"))
  .map((f, i) => {
    const bytes = new Uint8Array(readFileSync(join(guitarra, dir, f)));
    return { id: `${dir}/${f}`, slot: i, bytes, device: PRST.detect(bytes).key };
  });
const gp5 = load("gp5/Presets"), gp50 = load("gp50/Presets");
const crcOk = (b) => PRST.crc8(b.subarray(0x15)) === b[0x14];

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok  ", name); };

test("todos os presets decodificam; so os gabinetes acusticos ficam fora do catalogo", () => {
  for (const p of [...gp5, ...gp50]) {
    assert.ok(crcOk(p.bytes), p.id);
    const d = Preset.decode(p.bytes, catalogs[p.device]);
    assert.equal(d.blocks.length, 10);
    // CAB 0x3c "AC" e exclusivo da GP-50; 0x3d aparece nos presets acusticos e nao esta em nenhum catalogo.
    for (const b of d.blocks.filter((b) => !b.entry)) assert.ok([0x0a00003c, 0x0a00003d].includes(b.fxid), `${p.id} ${b.name} ${b.fxid.toString(16)}`);
  }
});

test("reescrever um bloco igual nao muda nenhum byte", () => {
  for (const p of gp5) for (let k = 0; k < 10; k++) {
    assert.deepEqual(Preset.writeBlock(p.bytes, k, Preset.readBlock(p.bytes, k)), p.bytes);
  }
});

test("copiar bloco GP-50 -> GP-5 muda so aquele bloco e mantem o CRC valido", () => {
  const source = gp50.find((p) => Preset.readBlock(p.bytes, 7).active);
  const k = 7; // DLY
  const plan = Bulk.planCopyBlock(gp5, { source, k }, catalogs);
  const src = Preset.readBlock(source.bytes, k);
  for (const r of plan.filter((r) => r.change)) {
    const t = gp5.find((p) => p.id === r.id);
    assert.equal(r.bytes.length, t.bytes.length);
    assert.ok(crcOk(r.bytes));
    assert.deepEqual(Preset.readBlock(r.bytes, k), src);
    for (let j = 0; j < 10; j++) if (j !== k) assert.deepEqual(Preset.readBlock(r.bytes, j), Preset.readBlock(t.bytes, j));
    assert.equal(PRST.readName(r.bytes), PRST.readName(t.bytes));
    assert.deepEqual(PRST.readOrder(r.bytes), PRST.readOrder(t.bytes));
  }
  assert.ok(plan.some((r) => r.change));
});

test("filtro 'so onde usa o modelo X'", () => {
  const k = 3; // AMP
  const fx = Preset.readBlock(gp5[0].bytes, k).fxid;
  const plan = Bulk.planCopyBlock(gp5, { source: gp5[1], k, onlyModels: new Set([fx]) }, catalogs);
  for (const r of plan) {
    const t = gp5.find((p) => p.id === r.id);
    if (r.change) assert.equal(Preset.readBlock(t.bytes, k).fxid, fx);
  }
});

test("modelo exclusivo da GP-50 nao entra em preset da GP-5", () => {
  const k = 1; // PRE
  const source = { ...gp50[0], id: "src", bytes: Preset.writeBlock(gp50[0].bytes, k, { fxid: 0x05000008 }) }; // C-Wah
  const plan = Bulk.planCopyBlock([...gp5.slice(0, 3), ...gp50.slice(1, 3)], { source, k }, catalogs);
  for (const r of plan.slice(0, 3)) { assert.equal(r.change, false); assert.match(r.note, /não existe na GP-5/); }
  assert.ok(plan.slice(3).some((r) => r.change));
});

test("renomear: modelo, acentos e limite de 16 caracteres", () => {
  const t = gp5.slice(0, 3);
  const plan = Bulk.planRename(t, { mode: "modelo", template: "{n:2} Ação {nome}", start: 7 });
  assert.equal(plan[0].after, `07 Acao ${PRST.readName(t[0].bytes)}`.slice(0, 16));
  for (const r of plan.filter((r) => r.change)) { assert.equal(PRST.readName(r.bytes), r.after); assert.ok(crcOk(r.bytes)); }
  const sub = Bulk.planRename(t, { mode: "substituir", find: "a", replace: "A" });
  for (const r of sub) assert.equal(r.after, r.before.replace(/a/gi, "A"));
});

test("ajustar parametro respeita o modelo e o limite do catalogo", () => {
  const k = 7, base = gp5.find((p) => Preset.readBlock(p.bytes, k).active);
  const fxid = Preset.readBlock(base.bytes, k).fxid;
  const p0 = catalogs.gp5.get(fxid).params[0];
  const plan = Bulk.planSetParam(gp5, { k, fxid, algId: p0.algId, value: 1e6 }, catalogs);
  for (const r of plan) {
    const t = gp5.find((p) => p.id === r.id);
    if (Preset.readBlock(t.bytes, k).fxid !== fxid) assert.equal(r.change, false);
    if (r.change) assert.equal(Preset.decode(r.bytes, catalogs.gp5).blocks[k].params[0].value, p0.max);
  }
});

test("ajustar parametro com troca de efeito: so troca com a opcao marcada", () => {
  const k = 3, t = gp5.slice(0, 6);
  const target = catalogs.gp5.models("AMP").find((m) => t.some((p) => Preset.readBlock(p.bytes, k).fxid !== m.fxid) && m.params.length);
  const alg = target.params[0].algId;
  const semTroca = Bulk.planSetParam(t, { k, fxid: target.fxid, algId: alg, value: 33 }, catalogs);
  for (const [i, r] of semTroca.entries()) if (Preset.readBlock(t[i].bytes, k).fxid !== target.fxid) { assert.equal(r.change, false); assert.match(r.note, /trocar para este efeito/); }
  const comTroca = Bulk.planSetParam(t, { k, fxid: target.fxid, algId: alg, value: 33, swap: true }, catalogs);
  for (const r of comTroca.filter((r) => r.change)) {
    assert.equal(Preset.readBlock(r.bytes, k).fxid, target.fxid);
    assert.equal(Math.round(Preset.decode(r.bytes, catalogs.gp5).blocks[k].params.find((p) => p.algId === alg).value), Math.min(33, target.params[0].max));
    assert.ok(crcOk(r.bytes));
  }
  assert.ok(comTroca.filter((r) => r.change).length >= semTroca.filter((r) => r.change).length);
});

test("CTL: le os blocos, grava preservando os outros bits e respeita 1 CTL na GP-5", () => {
  const slap = gp5.find((p) => p.id.includes("11-SlapPhasr"));
  assert.deepEqual(Preset.decode(slap.bytes, catalogs.gp5).ctl, [1 << 1]); // GP-5: so o CTL 1, com o PRE
  const raw = (b) => PRST.readFootswitches(b)[0];
  const b2 = Preset.writeCtl(slap.bytes, 0, (1 << 7) | (1 << 8));
  assert.equal(raw(b2) & 0x3ff, (1 << 7) | (1 << 8));
  assert.equal(raw(b2) & ~0x3ff, raw(slap.bytes) & ~0x3ff); // bits altos intactos
  assert.ok(crcOk(b2));
  const mixed = [...gp5.slice(0, 2), ...gp50.slice(0, 2)];
  const plan2 = Bulk.planCtl(mixed, { fs: 1, mode: "adicionar", mask: 1 << 8 });
  assert.match(plan2[0].note, /só tem 1 CTL/);
  assert.ok(plan2.slice(2).every((r) => r.change && Preset.readCtl(r.bytes)[1] & (1 << 8)));
  const rem = Bulk.planCtl(gp5.slice(0, 3), { fs: 0, mode: "remover", mask: 1 << 1 });
  for (const r of rem.filter((r) => r.change)) assert.equal(Preset.readCtl(r.bytes)[0] & (1 << 1), 0);
});

console.log(`\n${passed} testes ok (${gp5.length} presets GP-5, ${gp50.length} GP-50)`);
