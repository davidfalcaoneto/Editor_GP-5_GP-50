"use strict";
/*
 * bulk.js — edicao em massa. Cada operacao so PLANEJA: recebe os presets alvo
 * ({id, slot, bytes, device}) e devolve, para cada um, o resultado proposto
 * ({id, change, before, after, note, bytes}). A interface mostra a previa e so
 * grava o que o usuario aplicar. Nada aqui altera os bytes de entrada.
 */
(function (root) {
  const PRST = root.PRST || require("../lib/prst.js");
  const Preset = root.Preset || require("./preset.js");

  const NAME_LEN = PRST.NAME_LEN;
  const sameBytes = (a, z) => a.length === z.length && a.every((v, i) => v === z[i]);

  // O nome no aparelho e ASCII de ate 16 caracteres: tira acentos e o que sobrar.
  function cleanName(s) {
    return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e]/g, "");
  }

  function fillTemplate(tpl, vars) {
    return tpl.replace(/\{(nome|slot|n)(?::(\d+))?\}/gi, (_, key, width) => {
      const v = vars[key.toLowerCase()];
      const s = String(v ?? "");
      return width && typeof v === "number" ? s.padStart(Number(width), "0") : s;
    });
  }

  // rule: {mode: "modelo", template, start} | {mode: "substituir", find, replace, caseSensitive}
  //     | {mode: "caixa", caixa: "maiusculas"|"minusculas"|"titulo"}
  function planRename(targets, rule) {
    let n = Number(rule.start ?? 1);
    return targets.map((t) => {
      const before = PRST.readName(t.bytes);
      let raw = before;
      if (rule.mode === "modelo") raw = fillTemplate(rule.template || "{nome}", { nome: before, slot: t.slot ?? 0, n: n++ });
      else if (rule.mode === "substituir" && rule.find) {
        const esc = rule.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        raw = before.replace(new RegExp(esc, rule.caseSensitive ? "g" : "gi"), rule.replace ?? "");
      } else if (rule.mode === "caixa") {
        raw = rule.caixa === "maiusculas" ? before.toUpperCase()
          : rule.caixa === "minusculas" ? before.toLowerCase()
          : before.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
      }
      const cleaned = cleanName(raw).trim();
      const after = cleaned.slice(0, NAME_LEN);
      const notes = [];
      if (cleaned !== raw.trim()) notes.push("acentos/símbolos removidos");
      if (cleaned.length > NAME_LEN) notes.push(`cortado em ${NAME_LEN} caracteres`);
      if (!after) return { id: t.id, change: false, before, after: before, note: "nome ficaria vazio" };
      if (after === before) return { id: t.id, change: false, before, after, note: "sem mudança" };
      return { id: t.id, change: true, before, after, note: notes.join("; "), bytes: PRST.applyEdits(t.bytes, { name: after }) };
    });
  }

  // Copia o bloco k (modelo + os 8 parametros, e opcionalmente liga/desliga) de
  // `source` para cada alvo. onlyModels: Set de fxid — so troca onde o bloco
  // do alvo ja usa um desses modelos (ex.: "todos que usam o delay X").
  function planCopyBlock(targets, { source, k, withActive = true, onlyModels = null }, catalogs) {
    const src = Preset.readBlock(source.bytes, k);
    const label = catalogs[source.device].label(src.fxid);
    return targets.map((t) => {
      const cur = Preset.readBlock(t.bytes, k);
      const before = `${catalogs[t.device].label(cur.fxid)}${cur.active ? "" : " (off)"}`;
      const skip = (note) => ({ id: t.id, change: false, before, after: before, note });
      if (t.id === source.id) return skip("é o preset de origem");
      if (onlyModels && onlyModels.size && !onlyModels.has(cur.fxid)) return skip("usa outro modelo");
      // Modelo fora do catalogo so passa entre presets do mesmo aparelho (a origem prova que ele existe ali).
      if (!catalogs[t.device].has(src.fxid) && t.device !== source.device) return skip(`${label} não existe na ${PRST.profileFor(t.device).name}`);
      const part = { fxid: src.fxid, params: src.params };
      if (withActive) part.active = src.active;
      const bytes = Preset.writeBlock(t.bytes, k, part);
      const active = withActive ? src.active : cur.active;
      const after = `${label}${active ? "" : " (off)"}`;
      if (sameBytes(bytes, t.bytes)) return skip("já igual");
      const note = Preset.slotDependent(src.fxid) && t.device !== source.device
        ? "aponta para um slot de SnapTone/IR: confira se o mesmo conteúdo está gravado na outra pedaleira" : "";
      return { id: t.id, change: true, before, after, note, bytes };
    });
  }

  // Ajusta um parametro de um efeito especifico. mode "definir" grava o valor,
  // "somar" soma ao atual; o resultado fica dentro de min..max do catalogo.
  // swap: nos presets em que o bloco usa outro efeito, troca para este (os demais
  // parametros vao para o padrao do efeito) e entao ajusta; sem swap, eles ficam de fora.
  function planSetParam(targets, { k, fxid, algId, value, mode = "definir", swap = false }, catalogs) {
    fxid >>>= 0;
    return targets.map((t) => {
      const cat = catalogs[t.device];
      let cur = Preset.readBlock(t.bytes, k), base = t.bytes, swapped = false;
      if (cur.fxid !== fxid) {
        const skip = (note) => ({ id: t.id, change: false, before: cat.label(cur.fxid), after: cat.label(cur.fxid), note });
        if (!swap) return skip(`usa ${cat.label(cur.fxid)}, não ${cat.label(fxid)} (marque "trocar para este efeito" para mudar)`);
        if (!cat.has(fxid)) return skip(`${cat.label(fxid)} não existe na ${PRST.profileFor(t.device).name}`);
        base = Preset.writeBlock(t.bytes, k, { fxid, params: Preset.defaultParams(cat.get(fxid)) });
        cur = Preset.readBlock(base, k); swapped = true;
      }
      const p = cat.get(fxid) && cat.get(fxid).params.find((x) => x.algId === algId);
      if (!p) return { id: t.id, change: false, before: "—", after: "—", note: "o efeito não tem esse parâmetro" };
      const oldVal = new DataView(cur.params.buffer).getFloat32(algId * 4, true);
      const fmt = (v) => `${p.name} ${+v.toFixed(2)}`;
      let v = mode === "somar" ? oldVal + Number(value) : Number(value);
      v = Math.min(p.max ?? v, Math.max(p.min ?? v, v));
      const bytes = Preset.writeBlock(base, k, { values: { [algId]: v } });
      if (swapped) {
        const label = cat.label(Preset.readBlock(t.bytes, k).fxid);
        return { id: t.id, change: true, before: label, after: `${cat.label(fxid)} · ${fmt(v)}`, note: "efeito trocado; os outros parâmetros ficam no padrão", bytes };
      }
      if (Math.abs(v - oldVal) < 1e-6) return { id: t.id, change: false, before: fmt(oldVal), after: fmt(v), note: "sem mudança" };
      return { id: t.id, change: true, before: fmt(oldVal), after: fmt(v), note: "", bytes };
    });
  }

  // CTL: quais blocos o CTL fs (0 ou 1) liga/desliga. mode "definir" (exatamente
  // estes), "adicionar" ou "remover"; mask = bits dos blocos.
  function planCtl(targets, { fs, mode = "definir", mask }) {
    return targets.map((t) => {
      const n = Preset.CTL_COUNT[t.device];
      if (fs >= n) return { id: t.id, change: false, before: "—", after: "—", note: `a ${PRST.profileFor(t.device).name} só tem ${n} CTL` };
      const cur = Preset.readCtl(t.bytes)[fs];
      const next = mode === "adicionar" ? cur | mask : mode === "remover" ? cur & ~mask : mask;
      const res = { id: t.id, before: Preset.ctlLabel(cur), after: Preset.ctlLabel(next) };
      if (next === cur) return { ...res, change: false, note: "sem mudança" };
      return { ...res, change: true, note: "", bytes: Preset.writeCtl(t.bytes, fs, next) };
    });
  }

  function planToggle(targets, { k, active }) {
    return targets.map((t) => {
      const cur = Preset.readBlock(t.bytes, k);
      const txt = (a) => (a ? "ligado" : "desligado");
      if (cur.active === active) return { id: t.id, change: false, before: txt(cur.active), after: txt(active), note: "sem mudança" };
      return { id: t.id, change: true, before: txt(cur.active), after: txt(active), note: "", bytes: Preset.writeBlock(t.bytes, k, { active }) };
    });
  }

  const API = { cleanName, fillTemplate, planRename, planCopyBlock, planSetParam, planCtl, planToggle };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.Bulk = API;
})(typeof self !== "undefined" ? self : this);
