"use strict";
/*
 * preset.js — leitura e escrita de blocos de um .prst (GP-5 e GP-50).
 *
 * O corpo do preset guarda 10 blocos em ordem fixa de armazenamento (BLOCKS).
 * Cada bloco k tem: um registro de modelo de 4 bytes (fxid u32 LE), um bit no
 * bypass mask (1 = ligado) e 8 parametros float32 nos slots k*8..k*8+7. A ordem
 * da cadeia de sinal e um registro separado (PRST.readOrder) e nao muda aqui.
 *
 * Funciona no navegador (window.Preset) e no node (module.exports) para testes.
 */
(function (root) {
  const PRST = root.PRST || require("../lib/prst.js");

  const BLOCKS = ["NR", "PRE", "DST", "AMP", "CAB", "EQ", "MOD", "DLY", "RVB", "N→S"];
  const PARAMS_PER_BLOCK = 8;
  const USER_IR_BASE = 0x0a100000;
  const NS_CAT = 0x0f;

  const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

  // Catalogo: {fxid(number): {module, name, fxtitle, type, origin, params[]}}
  // setBankNames recebe os nomes lidos da pedaleira (SnapTones e User IRs), que
  // passam a aparecer no lugar de "SnapTone 12" / "User IR 3".
  function makeCatalog(ring) {
    const byId = new Map();
    for (const [k, e] of Object.entries(ring)) byId.set(Number(k) >>> 0, e);
    const byModule = {};
    for (const [fxid, e] of byId) (byModule[e.module] = byModule[e.module] || []).push({ fxid, ...e });
    for (const list of Object.values(byModule)) list.sort((a, z) => a.fxid - z.fxid);
    let banks = { snaptone: [], ir: [] };
    const get = (fxid) => byId.get(fxid >>> 0) || null;
    return {
      get, models: (module) => byModule[module] || [], has: (fxid) => byId.has(fxid >>> 0),
      setBankNames: (b) => { banks = { snaptone: b.snaptone || [], ir: b.ir || [] }; },
      label: (fxid) => modelLabel(get(fxid), fxid, banks),
    };
  }

  // Bloco cru: exatamente os bytes que definem o bloco, para copiar sem perda.
  function readBlock(bytes, k) {
    const mo = PRST.modelsOffset(bytes), po = PRST.paramsOffset(bytes);
    if (mo < 0 || po < 0) throw new Error("preset sem registros de modelo/parametros");
    const d = view(bytes);
    return {
      fxid: d.getUint32(mo + k * 4, true),
      active: !!((PRST.bypassMask(bytes) >> k) & 1),
      params: bytes.slice(po + k * PARAMS_PER_BLOCK * 4, po + (k + 1) * PARAMS_PER_BLOCK * 4),
    };
  }

  // Grava (parte de) um bloco e devolve um NOVO .prst com o CRC corrigido.
  // part: {fxid?, active?, params? (Uint8Array de 32 bytes), values? ({algId: float})}
  function writeBlock(bytes, k, part) {
    const b = Uint8Array.from(bytes), d = view(b);
    const mo = PRST.modelsOffset(b), po = PRST.paramsOffset(b), bo = PRST.bypassOffset(b);
    if (part.fxid != null) d.setUint32(mo + k * 4, part.fxid >>> 0, true);
    if (part.params) b.set(part.params, po + k * PARAMS_PER_BLOCK * 4);
    for (const [alg, v] of Object.entries(part.values || {})) d.setFloat32(po + (k * PARAMS_PER_BLOCK + Number(alg)) * 4, Number(v), true);
    if (part.active != null) {
      const bit = 1 << k, m = d.getUint32(bo, true);
      d.setUint32(bo, (part.active ? m | bit : m & ~bit) >>> 0, true);
    }
    PRST.refixCrc(b);
    return b;
  }

  // Valores padrao do catalogo para um modelo (usado ao trocar de modelo).
  function defaultParams(entry) {
    const out = new Uint8Array(PARAMS_PER_BLOCK * 4), d = view(out);
    for (const p of (entry && entry.params) || []) d.setFloat32(p.algId * 4, p.default ?? 0, true);
    return out;
  }

  function modelLabel(entry, fxid, banks = { snaptone: [], ir: [] }) {
    fxid >>>= 0;
    if (!entry) return `#${fxid.toString(16)}`;
    // N→S: o catalogo so diz "Empty"; o que importa e qual slot de SnapTone o bloco usa
    // (0..49 de fabrica, 50..79 do usuario).
    if ((fxid >>> 24) === NS_CAT) {
      const i = fxid & 0xffffff;
      return banks.snaptone[i] ? `${i} · ${banks.snaptone[i]}` : `SnapTone ${i}`;
    }
    if (fxid >= USER_IR_BASE && fxid < USER_IR_BASE + 0x100) {
      const i = fxid - USER_IR_BASE;
      return banks.ir[i] && banks.ir[i] !== `User IR ${i + 1}` ? `IR ${i + 1} · ${banks.ir[i]}` : `User IR ${i + 1}`;
    }
    return (entry.name || entry.fxtitle || "").trim();
  }

  // Visao completa para a interface.
  function decode(bytes, catalog) {
    const dev = PRST.detect(bytes);
    const floats = PRST.paramFloats(bytes);
    const [vol, bpm] = PRST.readVolBpm(bytes);
    const blocks = BLOCKS.map((name, k) => {
      const { fxid, active } = readBlock(bytes, k);
      const entry = catalog.get(fxid);
      return {
        k, name, fxid, active, entry,
        model: catalog.label(fxid),
        params: ((entry && entry.params) || []).map((p) => ({ ...p, value: floats[k * PARAMS_PER_BLOCK + p.algId] })),
      };
    });
    return { name: PRST.readName(bytes), device: dev.key, deviceName: dev.name, blocks, order: PRST.readOrder(bytes), vol, bpm, ctl: readCtl(bytes).slice(0, CTL_COUNT[dev.key]) };
  }

  // Referencias que dependem do que esta gravado em cada pedaleira (slots de
  // SnapTone e User IR): copiar entre aparelhos copia o numero, nao o conteudo.
  function slotDependent(fxid) {
    return (fxid >>> 24) === NS_CAT || ((fxid >>> 0) >= USER_IR_BASE && (fxid >>> 0) < USER_IR_BASE + 0x100);
  }

  // ---------- CTL (footswitches) ----------
  // Cada CTL e uma mascara de blocos (bits 0..9) num u32 do fim do .prst: a GP-5 usa
  // so o primeiro, a GP-50 os dois. Nos presets de fabrica os bits acima do 9 vem com
  // lixo; eles sao preservados ao gravar.
  const CTL_COUNT = { gp5: 1, gp50: 2 };
  const CTL_MASK = 0x3ff;
  const readCtl = (bytes) => PRST.readFootswitches(bytes).map((m) => m & CTL_MASK);
  function writeCtl(bytes, fs, mask) {
    const b = Uint8Array.from(bytes), off = PRST.fsOffset(b);
    if (off < 0) throw new Error("preset sem registro de CTL");
    const d = view(b), at = off + fs * 4;
    d.setUint32(at, ((d.getUint32(at, true) & ~CTL_MASK) | (mask & CTL_MASK)) >>> 0, true);
    PRST.refixCrc(b);
    return b;
  }
  const ctlBlocks = (mask) => BLOCKS.map((_, k) => k).filter((k) => (mask >> k) & 1);
  const ctlLabel = (mask) => ctlBlocks(mask).map((k) => BLOCKS[k]).join(" + ") || "nenhum";

  // ---------- ordem da cadeia ----------
  // DST, N→S, AMP, CAB e EQ formam um nucleo fixo, nessa ordem; NR, PRE, MOD, DLY
  // e RVB vao antes ou depois dele, em qualquer ordem (regra da propria pedaleira).
  const CORE = [2, 9, 3, 4, 5];
  const MOVABLE = new Set([0, 1, 6, 7, 8]);
  // Move o bloco k para a posicao `to` (indice na cadeia). Devolve a nova ordem ou null.
  function moveInOrder(order, k, to) {
    if (!MOVABLE.has(k)) return null;
    const rest = order.filter((b) => b !== k);
    to = Math.max(0, Math.min(rest.length, to));
    const out = [...rest.slice(0, to), k, ...rest.slice(to)];
    const core = out.filter((b) => !MOVABLE.has(b));
    const first = out.indexOf(core[0]);
    const contiguous = out.slice(first, first + core.length).every((b, i) => b === core[i]);
    return contiguous && core.every((b, i) => b === CORE[i]) ? out : null;
  }

  // Diferencas que se ouvem (ou aparecem na tela) entre dois presets: nome, ordem,
  // volume, modelo, liga/desliga e os parametros que o catalogo conhece. Usado para
  // conferir uma gravacao sem acusar bytes que nenhum modelo usa.
  function diff(a, z, catalog, { name = true, bpm = true } = {}) {
    const A = decode(a, catalog), Z = decode(z, catalog), out = [];
    if (name && A.name.trim() !== Z.name.trim()) out.push(`nome "${A.name}" → "${Z.name}"`);
    if (A.order.join() !== Z.order.join()) out.push("ordem da cadeia");
    if (A.vol !== Z.vol) out.push(`volume ${A.vol} → ${Z.vol}`);
    if (bpm && A.bpm !== Z.bpm) out.push(`BPM ${A.bpm} → ${Z.bpm}`);
    A.ctl.forEach((m, fs) => { if (m !== Z.ctl[fs]) out.push(`CTL${A.ctl.length > 1 ? " " + (fs + 1) : ""}: ${ctlLabel(m)} → ${ctlLabel(Z.ctl[fs])}`); });
    for (let k = 0; k < BLOCKS.length; k++) {
      const x = A.blocks[k], y = Z.blocks[k];
      if (x.fxid !== y.fxid) { out.push(`${x.name}: modelo ${x.model} → ${y.model}`); continue; }
      if (x.active !== y.active) out.push(`${x.name}: ${y.active ? "ligado" : "desligado"}`);
      x.params.forEach((p, i) => { if (Math.abs(p.value - y.params[i].value) > 1e-3) out.push(`${x.name} ${p.name}: ${+p.value.toFixed(2)} → ${+y.params[i].value.toFixed(2)}`); });
    }
    return out;
  }

  const API = { BLOCKS, PARAMS_PER_BLOCK, CORE, MOVABLE, CTL_COUNT, readCtl, writeCtl, ctlBlocks, ctlLabel, makeCatalog, readBlock, writeBlock, defaultParams, decode, modelLabel, slotDependent, moveInOrder, diff };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.Preset = API;
})(typeof self !== "undefined" ? self : this);
