"use strict";
/*
 * equivalents.js — modelos que existem numa pedaleira e nao na outra, e o que usar
 * no lugar ao converter um preset, para ele continuar funcionando.
 *
 * Todos os modelos da GP-5 existem na GP-50. Da GP-50 para a GP-5 faltam:
 *   PRE C-Wah (wah de pedal), PRE AC Sim (simulador de violao), CAB AC e o gabinete
 *   acustico 0x0a00003d (fora dos catalogos; aparece nos presets acusticos de fabrica).
 * Os demais modelos tem os mesmos bytes nas duas: delays e modulacoes sincronizados
 * com o BPM gravam Time = figura e o slot 3 = 1 do mesmo jeito (a GP-5 so nao mostra
 * esse "Sync" no catalogo).
 *
 *   const { bytes, notes } = Equivalents.adapt(prst, "gp5", { gp5: cat5, gp50: cat50 });
 */
(function (root) {
  const PRST = root.PRST || require("../lib/prst.js");
  const Preset = root.Preset || require("./preset.js");

  // fxid de origem -> { to: fxid no destino (null = bloco desligado), params: {algId origem: algId destino}, note }
  const TO_GP5 = {
    0x05000008: {
      to: 0x0100000f, params: { 0: 1, 1: 2 }, set: { 3: 100 },
      note: "C-Wah (wah de pedal) não existe na GP-5: virou Toucher (wah que segue a palhetada), com o mesmo Range e Q",
    },
    0x01000001: { to: null, note: "AC Sim não existe na GP-5: o bloco PRE ficou desligado (o som de violão vem do AMP AC Pre1/AC Pre2)" },
    0x0a00003c: { to: null, note: "o gabinete AC não existe na GP-5: o CAB ficou desligado (nos presets acústicos de fábrica ele já vem desligado)" },
    0x0a00003d: { to: null, note: "o gabinete acústico da GP-50 não existe na GP-5: o CAB ficou desligado (nos presets acústicos de fábrica ele já vem desligado)" },
  };
  const TABLE = { gp5: TO_GP5, gp50: {} };
  // Modelos que a pedaleira tem mas o catalogo nao lista (aparecem nos presets de fabrica).
  const EXTRA = { gp5: [], gp50: [0x0a00003d] };
  const exists = (key, fxid, catalogs) => catalogs[key].has(fxid) || EXTRA[key].includes(fxid >>> 0);

  const f32 = (blk, alg) => new DataView(blk.params.buffer).getFloat32(alg * 4, true);

  // Modelo neutro para um bloco sem equivalente: o primeiro do mesmo tipo no destino.
  function neutralFor(fxid, catalog) {
    const cat = fxid >>> 24;
    for (const module of ["NR", "PRE", "DST", "AMP", "CAB", "EQ", "MOD", "DLY", "RVB"]) {
      const list = catalog.models(module).filter((m) => !/User IR/.test(m.name));
      if (list.some((m) => m.fxid >>> 24 === cat)) return list.find((m) => m.fxid >>> 24 === cat);
    }
    return null;
  }

  // Troca, no proprio formato do preset, os modelos que o destino nao tem. Os outros
  // bytes nao mudam; depois e so PRST.convert(bytes, target).
  function adapt(bytes, target, catalogs) {
    const src = PRST.detect(bytes).key, notes = [];
    let b = bytes;
    if (src === target) return { bytes: b, notes };
    for (let k = 0; k < Preset.BLOCKS.length; k++) {
      const cur = Preset.readBlock(b, k);
      if (exists(target, cur.fxid, catalogs)) continue;
      const rule = TABLE[target][cur.fxid];
      const to = rule && rule.to != null ? catalogs[target].get(rule.to) : null;
      if (to) {
        const params = Preset.defaultParams(to), d = new DataView(params.buffer);
        for (const [from, dest] of Object.entries(rule.params || {})) d.setFloat32(Number(dest) * 4, f32(cur, Number(from)), true);
        for (const [alg, v] of Object.entries(rule.set || {})) d.setFloat32(Number(alg) * 4, v, true);
        b = Preset.writeBlock(b, k, { fxid: rule.to, params });
      } else {
        const n = neutralFor(cur.fxid, catalogs[target]);
        if (!n) throw new Error(`${Preset.BLOCKS[k]}: nenhum modelo parecido na ${PRST.profileFor(target).name}`);
        b = Preset.writeBlock(b, k, { fxid: n.fxid, params: Preset.defaultParams(n), active: false });
      }
      const name = catalogs[src].label(cur.fxid);
      const wasOff = !to && !cur.active ? " (já estava desligado)" : "";
      notes.push(`${Preset.BLOCKS[k]}: ${rule ? rule.note : `${name} não existe na ${PRST.profileFor(target).name}: o bloco ficou desligado`}${wasOff}`);
    }
    return { bytes: b, notes };
  }

  // Converte para o aparelho `target`, trocando antes o que ele nao tem.
  function toDevice(bytes, target, catalogs) {
    if (PRST.detect(bytes).key === target) return { bytes, notes: [] };
    const a = adapt(bytes, target, catalogs);
    return { bytes: PRST.convert(a.bytes, target), notes: a.notes };
  }

  const API = { TABLE, EXTRA, exists, adapt, toDevice };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.Equivalents = API;
})(typeof self !== "undefined" ? self : this);
