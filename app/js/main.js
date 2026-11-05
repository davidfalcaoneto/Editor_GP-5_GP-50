"use strict";
/* main.js — interface do editor. Estado em S; cada preset guarda os bytes atuais e os originais.
 *
 * Tres telas: Editor (um preset: cadeia de sinal, bloco, tempo e volume), Biblioteca
 * (lista de presets abertos + edicao em massa) e Pedaleira (backups, IRs/SnapTones,
 * nomes, log). Com a pedaleira conectada, o preset do Editor fica "ao vivo": o que
 * muda na tela vai para a memoria de trabalho dela na hora, e Salvar grava no slot.
 */
(async function () {
  const { PRST, Preset, Bulk, Device } = window;
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const pad2 = (n) => String(n).padStart(2, "0");
  const same = (a, z) => a.length === z.length && a.every((v, i) => v === z[i]);
  const clamp = (v, a, z) => Math.min(z, Math.max(a, v));

  const loadJson = (f) => fetch(f).then((r) => r.json());
  const catalogs = {
    gp5: Preset.makeCatalog(await loadJson("data/fxid_ring_gp5.json")),
    gp50: Preset.makeCatalog(await loadJson("data/fxid_ring.json")),
  };
  const SUMMARY = [0, 1, 2, 9, 3, 4, 5, 6, 7, 8]; // colunas da tabela: todos os blocos, na ordem padrao da cadeia
  // [sigla, nome, cor] por bloco, na ordem de armazenamento (Preset.BLOCKS)
  const BLOCK_INFO = [
    ["NR", "Noise gate", "#94a3b8"], ["PRE", "Pré-efeitos", "#eab308"], ["DST", "Drive", "#f97316"],
    ["AMP", "Amplificador", "#ef4444"], ["CAB", "Gabinete", "#c08457"], ["EQ", "Equalizador", "#14b8a6"],
    ["MOD", "Modulação", "#a855f7"], ["DLY", "Delay", "#3b82f6"], ["RVB", "Reverb", "#06b6d4"], ["N→S", "NAM / SnapTone", "#ec4899"],
  ];
  const AMP = 3, CAB = 4, DLY = 7, NS = 9, DLY_TIME = 1;
  const KEY_BLOCKS = [0, 1, 2, 9, 3, 4, 5, 6, 7, 8]; // teclas 1..0, na ordem padrao da cadeia
  const BPM_RANGE = [40, 300];
  // Time do delay sincronizado com o BPM do preset: guarda a figura (0..10), nao ms
  // (visto nos presets de fabrica da GP-5: Time 8 = 1/8 pontuada no "Dot18").
  const DIVS = ["1/1", "1/2", "1/2 pont.", "1/2 tercina", "1/4", "1/4 pont.", "1/4 tercina", "1/8", "1/8 pont.", "1/8 tercina", "1/16"];
  const isSynced = (pr) => pr.unit === "ms" && pr.value < pr.min && pr.value >= 0 && pr.value <= DIVS.length - 1;

  const S = {
    presets: [], selected: new Set(), current: null, block: AMP, undo: [], plan: null, backups: [], stop: false, seq: 0,
    busy: false, devNames: null, banks: null, pedalSlot: null, pedalLog: [], taps: [], bpmShown: null,
  };
  const byId = (id) => S.presets.find((p) => p.id === id);
  const cur = () => byId(S.current);

  // ---------- avisos ----------
  let toastTimer;
  function toast(msg, err = false) {
    const t = $("#toast");
    t.textContent = msg; t.className = "toast" + (err ? " err" : ""); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), err ? 9000 : 4000);
  }
  const fail = (e) => { console.error(e); toast(e.message || String(e), true); };
  function progress(i, total, text) {
    const el = $("#progress");
    el.hidden = i >= total;
    el.style.setProperty("--p", `${(100 * i) / Math.max(total, 1)}%`);
    $(".txt", el).textContent = text || `${i}/${total}`;
  }
  $("#btnStop").onclick = () => (S.stop = true);

  // ---------- presets abertos ----------
  function addPreset({ id, slot, bytes, fileName = null, source }) {
    const p = { id, slot, bytes, original: bytes, fileName, source, device: PRST.detect(bytes).key };
    const i = S.presets.findIndex((x) => x.id === id);
    if (i >= 0) S.presets[i] = p; else S.presets.push(p);
    return p;
  }
  const isDirty = (p) => !same(p.bytes, p.original);
  const devId = (key, slot) => `dev:${key}:${slot}`;
  const sortPresets = () => S.presets.sort((a, z) => (a.source === z.source ? (a.slot ?? 999) - (z.slot ?? 999) : a.source.localeCompare(z.source)));
  const slotName = (slot) => ((S.devNames || []).find((n) => n.slot === slot) || {}).name ?? `slot${slot}`;

  function setBytes(p, bytes, { undo = true } = {}) {
    if (same(bytes, p.bytes)) return;
    if (undo) pushUndo(new Map([[p.id, p.bytes]]));
    p.bytes = bytes;
  }
  function pushUndo(snapshot) { S.undo.push(snapshot); if (S.undo.length > 100) S.undo.shift(); }
  function undo() {
    const snap = S.undo.pop();
    if (!snap) return;
    for (const [id, bytes] of snap) { const p = byId(id); if (p) p.bytes = bytes; }
    S.plan = null; renderAll();
  }
  $("#btnUndo").onclick = $("#btnUndoLib").onclick = undo;

  // ---------- biblioteca ----------
  function visible() {
    const q = $("#filter").value.trim().toLowerCase();
    if (!q) return S.presets;
    return S.presets.filter((p) => {
      const d = Preset.decode(p.bytes, catalogs[p.device]);
      return [d.name, String(p.slot ?? ""), ...d.blocks.map((b) => b.model)].some((s) => s.toLowerCase().includes(q));
    });
  }

  const ctlText = (d) => (d.ctl.length > 1 ? d.ctl.map((m, i) => `${i + 1}: ${Preset.ctlLabel(m)}`).join(" · ") : Preset.ctlLabel(d.ctl[0]));

  function renderTable() {
    const vis = visible();
    const rows = vis.map((p) => {
      const d = Preset.decode(p.bytes, catalogs[p.device]);
      const cells = SUMMARY.map((k) => {
        const b = d.blocks[k];
        return `<td class="${b.active ? "" : "off"} ${b.entry ? "" : "unknown"}" title="${esc(b.entry ? b.entry.origin || "" : "modelo fora do catálogo")}">${esc(b.model)}</td>`;
      }).join("");
      const cls = [S.selected.has(p.id) && "sel", S.current === p.id && "current"].filter(Boolean).join(" ");
      return `<tr data-id="${esc(p.id)}" class="${cls}">
        <td><input type="checkbox" ${S.selected.has(p.id) ? "checked" : ""}></td>
        <td>${p.slot ?? "—"}</td><td class="name">${esc(d.name)}</td><td title="${esc(p.fileName ? `arquivo ${p.fileName}` : p.source === "pedaleira" ? "lido da pedaleira" : p.source)}">${d.deviceName}</td><td class="ctl" title="Blocos que o CTL liga/desliga">${esc(ctlText(d))}</td>${cells}
        <td class="${isDirty(p) ? "dirty" : ""}" title="${isDirty(p) ? "alterado, ainda não salvo" : ""}"></td></tr>`;
    });
    $("#presetTable tbody").innerHTML = rows.join("");
    $("#emptyHint").hidden = S.presets.length > 0;
    $("#selCount").textContent = S.selected.size ? `${S.selected.size} selecionado(s)` : "";
    $("#bulkCount").textContent = $("#selCountBar").textContent = S.selected.size;
    $("#btnSave").disabled = !S.selected.size;
    $("#btnWrite").disabled = !S.selected.size || !Device.isConnected() || S.busy;
    $("#libCount").textContent = S.presets.length || "";
    $("#chkAll").checked = vis.length > 0 && vis.every((p) => S.selected.has(p.id));
  }

  $("#presetTable tbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr"); if (!tr) return;
    const id = tr.dataset.id;
    if (e.target.matches("input[type=checkbox]")) {
      e.target.checked ? S.selected.add(id) : S.selected.delete(id);
    } else if (e.ctrlKey || e.metaKey) {
      S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id);
    } else {
      S.current = id;
      showView("viewEditor");
    }
    S.plan = null; renderAll();
  });
  $("#filter").oninput = renderTable;
  $("#btnSelVisible").onclick = () => { visible().forEach((p) => S.selected.add(p.id)); S.plan = null; renderAll(); };
  $("#btnSelNone").onclick = () => { S.selected.clear(); S.plan = null; renderAll(); };
  $("#chkAll").onchange = (e) => { visible().forEach((p) => (e.target.checked ? S.selected.add(p.id) : S.selected.delete(p.id))); S.plan = null; renderAll(); };

  // ---------- abrir arquivos ----------
  const slotFromName = (n) => { const m = /^(\d{1,2})\s*-/.exec(n); return m ? Number(m[1]) : null; };
  async function addFiles(files) {
    let ok = 0; const bad = [];
    for (const f of files) {
      if (!f.name.toLowerCase().endsWith(".prst")) continue;
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        Preset.decode(bytes, catalogs[PRST.detect(bytes).key]);
        addPreset({ id: `arq:${S.seq++}:${f.name}`, slot: slotFromName(f.name), bytes, fileName: f.name, source: "arquivo" });
        ok++;
      } catch (e) { bad.push(`${f.name}: ${e.message}`); }
    }
    showView("viewLibrary");
    renderAll();
    toast(`${ok} preset(s) aberto(s)` + (bad.length ? `\nIgnorados:\n${bad.join("\n")}` : ""), bad.length > 0);
  }
  $("#inFiles").onchange = (e) => { addFiles([...e.target.files]); e.target.value = ""; };
  $("#btnFolder").onclick = async () => {
    if (!window.showDirectoryPicker) return $("#inFiles").click();
    try {
      const dir = await showDirectoryPicker();
      const files = [];
      for await (const h of dir.values()) if (h.kind === "file" && h.name.toLowerCase().endsWith(".prst")) files.push(await h.getFile());
      files.sort((a, z) => a.name.localeCompare(z.name, undefined, { numeric: true }));
      addFiles(files);
    } catch (e) { if (e.name !== "AbortError") fail(e); }
  };
  document.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); });
  document.addEventListener("drop", (e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); addFiles([...e.dataTransfer.files]); });

  // ---------- salvar arquivos ----------
  const incompatible = (bytes, target) =>
    Preset.decode(bytes, catalogs[PRST.detect(bytes).key]).blocks.filter((b) => !catalogs[target].has(b.fxid)).map((b) => `${b.name} ${b.model}`);

  function exportBytes(p, format) {
    const target = format || p.device;
    if (target === p.device) return p.bytes;
    const bad = incompatible(p.bytes, target);
    if (bad.length) throw new Error(`não existe na ${PRST.profileFor(target).name}: ${bad.join(", ")}`);
    return PRST.convert(p.bytes, target);
  }
  const safeName = (s) => s.replace(/[\\/:*?"<>|]/g, "_");
  function fileNameFor(p) {
    const name = PRST.readName(p.bytes);
    if (p.fileName && name === PRST.readName(p.original)) return p.fileName;
    return `${p.slot != null ? pad2(p.slot) + "-" : ""}${safeName(name)}.prst`;
  }
  function download(name, bytes) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes])); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  async function saveToFolder(items) { // items: [{name, bytes}]
    if (!window.showDirectoryPicker) { items.forEach((it) => download(it.name, it.bytes)); return; }
    const dir = await showDirectoryPicker({ mode: "readwrite" });
    for (const it of items) {
      const w = await (await dir.getFileHandle(it.name, { create: true })).createWritable();
      await w.write(it.bytes); await w.close();
    }
  }
  $("#btnSave").onclick = async () => {
    const sel = S.presets.filter((p) => S.selected.has(p.id));
    if (!sel.length) return toast("Selecione os presets que quer salvar.", true);
    const format = $("#saveFormat").value, items = [], bad = [];
    for (const p of sel) {
      try { items.push({ p, name: fileNameFor(p), bytes: exportBytes(p, format) }); }
      catch (e) { bad.push(`${PRST.readName(p.bytes)}: ${e.message}`); }
    }
    try {
      await saveToFolder(items);
      if (!format) for (const it of items) if (it.p.source === "arquivo") { it.p.original = it.p.bytes; it.p.fileName = it.name; }
      renderAll();
      toast(`${items.length} arquivo(s) salvo(s)` + (bad.length ? `\nNão salvos:\n${bad.join("\n")}` : ""), bad.length > 0);
    } catch (e) { if (e.name !== "AbortError") fail(e); }
  };
  $("#btnExport").onclick = async () => {
    const p = cur(); if (!p) return;
    try {
      const format = $("#exportFormat").value, bytes = exportBytes(p, format);
      const name = format && format !== p.device ? fileNameFor(p).replace(/\.prst$/i, `-${format}.prst`) : fileNameFor(p);
      if (window.showSaveFilePicker) {
        const h = await showSaveFilePicker({ suggestedName: name, types: [{ description: "Preset Valeton", accept: { "application/octet-stream": [".prst"] } }] });
        const w = await h.createWritable(); await w.write(bytes); await w.close();
      } else download(name, bytes);
      toast(`Exportado: ${name}`);
    } catch (e) { if (e.name !== "AbortError") fail(e); }
  };

  // ---------- editor: cabecalho ----------
  function renderHead(p, d) {
    $("#edSlotBig").textContent = p.slot != null ? pad2(p.slot) : "--";
    if (document.activeElement !== $("#edName")) $("#edName").value = d.name;
    if (document.activeElement !== $("#edSlot")) $("#edSlot").value = p.slot ?? "";
    $("#edDevice").textContent = d.deviceName;
    $("#edOrigin").textContent = p.source === "pedaleira" ? "da pedaleira" : p.fileName ? `arquivo ${p.fileName}` : p.source;
    $("#edDirty").hidden = !isDirty(p);
  }
  $("#edName").onchange = (e) => {
    const p = cur(); if (!p) return;
    const name = Bulk.cleanName(e.target.value).trim().slice(0, PRST.NAME_LEN);
    if (name) setBytes(p, PRST.applyEdits(p.bytes, { name }));
    renderAll();
  };
  $("#edSlot").onchange = (e) => {
    const p = cur(); if (!p) return;
    const v = e.target.value === "" ? null : clamp(Math.trunc(Number(e.target.value)), 0, 99);
    if (v === p.slot) return;
    // mudar o slot de um preset lido da pedaleira faz dele uma copia para outro slot
    if (p.source === "pedaleira") p.source = "cópia";
    p.slot = v;
    if (live.id === p.id) stopLive();
    renderAll();
  };
  $("#btnRevert").onclick = () => { const p = cur(); if (p) { setBytes(p, p.original); renderAll(); } };

  // ---------- editor: cadeia de sinal ----------
  const ctlMark = (d, k) => {
    const on = d.ctl.map((m, fs) => ((m >> k) & 1 ? (d.ctl.length > 1 ? `C${fs + 1}` : "CTL") : "")).filter(Boolean);
    return on.length ? `<span class="ctl-mark" title="no ${on.join(" e ")}">${on.join(" ")}</span>` : "";
  };
  function renderChain(p, d) {
    const nsOn = d.blocks[NS].active;
    $("#chain").innerHTML = d.order.map((k) => {
      const b = d.blocks[k], [label, , color] = BLOCK_INFO[k];
      const cls = ["fx", b.active && "on", S.block === k && "sel", nsOn && (k === AMP || k === CAB) && "bypassed", !b.entry && "unknown"].filter(Boolean).join(" ");
      const tip = `${label}: ${b.model}${b.entry && b.entry.origin ? " — " + b.entry.origin : ""}${nsOn && (k === AMP || k === CAB) ? " (ignorado: N→S ligado)" : ""}`;
      return `<div class="${cls}" style="--c:${color}" data-k="${k}" draggable="${Preset.MOVABLE.has(k)}" title="${esc(tip)}">
        <span class="led"></span>${ctlMark(d, k)}<span class="glyph">${esc(label)}</span><span class="model">${esc(b.model)}</span></div>`;
    }).join("");
  }
  const chainEl = $("#chain");
  chainEl.addEventListener("click", (e) => {
    const t = e.target.closest(".fx"), p = cur(); if (!t || !p) return;
    // so troca a selecao, sem redesenhar a cadeia (senao o duplo clique perde o elemento)
    S.block = Number(t.dataset.k);
    $$(".fx", chainEl).forEach((x) => x.classList.toggle("sel", x === t));
    renderBlock(p, Preset.decode(p.bytes, catalogs[p.device]));
  });
  chainEl.addEventListener("dblclick", (e) => {
    const t = e.target.closest(".fx"); if (!t) return;
    toggleBlock(Number(t.dataset.k));
  });
  function toggleBlock(k) {
    const p = cur(); if (!p) return;
    setBytes(p, Preset.writeBlock(p.bytes, k, { active: !Preset.readBlock(p.bytes, k).active }));
    renderAll();
  }
  // arrastar: so NR, PRE, MOD, DLY e RVB, e so para onde a pedaleira aceita (Preset.moveInOrder)
  let dragK = null;
  function dropOrder(e) {
    const t = e.target.closest(".fx"), p = cur();
    if (!t || !p || dragK == null || Number(t.dataset.k) === dragK) return null;
    const order = PRST.readOrder(p.bytes), rest = order.filter((b) => b !== dragK);
    const r = t.getBoundingClientRect(), before = e.clientX - r.left < r.width / 2;
    const at = rest.indexOf(Number(t.dataset.k)) + (before ? 0 : 1);
    const next = Preset.moveInOrder(order, dragK, at);
    return next && next.join() !== order.join() ? { next, t, before } : null;
  }
  const clearDrop = () => $$(".fx", chainEl).forEach((x) => x.classList.remove("drop-before", "drop-after"));
  chainEl.addEventListener("dragstart", (e) => {
    const t = e.target.closest(".fx"); if (!t || t.draggable === false) return;
    dragK = Number(t.dataset.k); t.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", t.dataset.k);
  });
  chainEl.addEventListener("dragend", () => { dragK = null; clearDrop(); $$(".fx.dragging", chainEl).forEach((x) => x.classList.remove("dragging")); });
  chainEl.addEventListener("dragover", (e) => {
    if (dragK == null) return;
    e.preventDefault(); clearDrop();
    const r = dropOrder(e);
    if (r) r.t.classList.add(r.before ? "drop-before" : "drop-after");
  });
  chainEl.addEventListener("drop", (e) => {
    if (dragK == null) return;
    e.preventDefault();
    const r = dropOrder(e), p = cur();
    dragK = null; clearDrop();
    if (r && p) { setBytes(p, PRST.applyEdits(p.bytes, { order: r.next })); renderAll(); }
  });

  // ---------- editor: bloco selecionado ----------
  function modelOptions(module, device, fxid) {
    const list = catalogs[device].models(module);
    const opts = list.map((m) => `<option value="${m.fxid}" ${m.fxid === fxid ? "selected" : ""}>${esc(catalogs[device].label(m.fxid))}${m.origin ? " — " + esc(m.origin) : ""}</option>`);
    if (!list.some((m) => m.fxid === fxid)) opts.unshift(`<option value="${fxid}" selected>#${fxid.toString(16)} (fora do catálogo)</option>`);
    return opts.join("");
  }
  const fmt = (v, step) => +v.toFixed(step && step < 1 ? 2 : 0);
  function renderBlock(p, d) {
    const k = S.block, b = d.blocks[k], [label, title, color] = BLOCK_INFO[k];
    const module = b.entry ? b.entry.module : Preset.BLOCKS[k];
    const desc = b.entry ? [b.entry.fxtitle, b.entry.origin].filter((x) => x && x.trim()).join(" · ") : "modelo fora do catálogo";
    const params = b.params.map((pr) => {
      const v = fmt(pr.value, pr.step), id = `prm-${k}-${pr.algId}`;
      if (k === DLY && pr.algId === DLY_TIME && pr.unit === "ms") {
        const synced = isSynced(pr);
        const opts = `<option value="ms" ${synced ? "" : "selected"}>ms</option>` + DIVS.map((n, i) => `<option value="${i}" ${synced && Math.round(pr.value) === i ? "selected" : ""}>♪ ${n}</option>`).join("");
        const attrs = `min="${pr.min}" max="${pr.max}" step="${pr.step || 1}" data-alg="${pr.algId}"`;
        return `<div class="param"><div class="param-head"><label for="${id}">${esc(pr.name)}</label>
            <span class="pval"><select data-sync="${pr.algId}" title="ms ou sincronizado com o BPM do preset">${opts}</select>
            ${synced ? "" : `<input type="number" ${attrs} value="${v}" aria-label="${esc(pr.name)}">`}</span></div>
          ${synced ? `<p class="muted small">Sincronizado com o BPM do preset (cartão Tempo).</p>` : `<input id="${id}" type="range" ${attrs} value="${v}">`}</div>`;
      }
      if (pr.toggle) {
        return `<div class="param"><div class="param-head"><label for="${id}">${esc(pr.name)}</label>
          <span class="switch"><input id="${id}" type="checkbox" data-alg="${pr.algId}" ${v ? "checked" : ""}><span></span></span></div></div>`;
      }
      const attrs = `min="${pr.min}" max="${pr.max}" step="${pr.step || 1}" data-alg="${pr.algId}"`;
      return `<div class="param"><div class="param-head"><label for="${id}">${esc(pr.name)}</label>
          <span class="pval"><input type="number" ${attrs} value="${v}" aria-label="${esc(pr.name)}"> ${esc(pr.unit || "")}</span></div>
        <input id="${id}" type="range" ${attrs} value="${v}"></div>`;
    }).join("");
    const bypassNote = d.blocks[NS].active && (k === AMP || k === CAB) ? `<p class="warn small">Com o N→S ligado, a pedaleira ignora o ${label}.</p>` : "";
    $("#blockCard").innerHTML = `
      <div class="blk-head"><span class="glyph" style="--c:${color}">${esc(label)}</span>
        <div class="blk-title"><b>${esc(title)}</b><span class="muted small">${b.active ? "ligado" : "desligado"} · tecla ${KEY_BLOCKS.indexOf(k) === 9 ? 0 : KEY_BLOCKS.indexOf(k) + 1}</span></div>
        <span class="switch" title="ligar/desligar (duplo clique na cadeia)"><input type="checkbox" data-act ${b.active ? "checked" : ""} aria-label="ligar/desligar ${esc(label)}"><span></span></span></div>
      <select class="blk-model" data-model aria-label="Modelo">${modelOptions(module, p.device, b.fxid)}</select>
      <p class="blk-desc">${esc(desc)}</p>${bypassNote}
      ${params || `<p class="empty-params">Este modelo não tem parâmetros.</p>`}`;
  }
  const blockEl = $("#blockCard");
  blockEl.addEventListener("input", (e) => { // espelha range <-> numero e manda o valor na hora (ao vivo)
    const el = e.target; if (!el.dataset.alg || el.type === "checkbox" || el.value === "") return;
    $$(`input[data-alg="${el.dataset.alg}"]`, blockEl).forEach((o) => o !== el && (o.value = el.value));
    if (isLiveCurrent()) Device.liveParam(S.block, Number(el.dataset.alg), Number(el.value));
  });
  blockEl.addEventListener("change", (e) => {
    const p = cur(), el = e.target, k = S.block;
    if (!p) return;
    if (el.dataset.act !== undefined) setBytes(p, Preset.writeBlock(p.bytes, k, { active: el.checked }));
    else if (el.dataset.sync !== undefined) {
      const pr = catalogs[p.device].get(Preset.readBlock(p.bytes, k).fxid).params.find((x) => x.algId === Number(el.dataset.sync));
      setBytes(p, Preset.writeBlock(p.bytes, k, { values: { [el.dataset.sync]: el.value === "ms" ? pr.default : Number(el.value) } }));
    }
    else if (el.dataset.model !== undefined) {
      const fxid = Number(el.value) >>> 0;
      setBytes(p, Preset.writeBlock(p.bytes, k, { fxid, params: Preset.defaultParams(catalogs[p.device].get(fxid)) }));
    } else if (el.dataset.alg) {
      let v = el.type === "checkbox" ? (el.checked ? 1 : 0) : Number(el.value);
      if (el.type === "number") v = clamp(v, Number(el.min), Number(el.max));
      setBytes(p, Preset.writeBlock(p.bytes, k, { values: { [el.dataset.alg]: v } }));
    }
    renderAll();
  });

  // ---------- editor: tempo e volume ----------
  // Modo "bpm": BPM do preset (GP-50 sempre; GP-5 quando o delay esta sincronizado).
  // Modo "delay" (GP-5 com delay em ms): o tempo ajusta o Time do delay (1/4, 1/8 ou
  // 1/8 pontuada), como o tap da propria pedaleira.
  const delayTime = (d) => d.blocks[DLY].params.find((x) => x.algId === DLY_TIME && x.unit === "ms");
  const tempoMode = (p, d) => {
    const t = delayTime(d);
    if (p.device === "gp50" || (t && isSynced(t))) return "bpm";
    return t ? "delay" : null;
  };
  const division = () => Number(($("#divGroup input:checked") || { value: 1 }).value);
  function currentBpm(p, d) {
    const mode = tempoMode(p, d);
    if (mode === "bpm") return d.bpm;
    if (!mode) return null;
    const ms = delayTime(d).value;
    if (S.bpmShown && S.bpmShown.id === p.id && Math.round((60000 / S.bpmShown.bpm) * division()) === Math.round(ms)) return S.bpmShown.bpm;
    return Math.round((60000 * division()) / ms);
  }
  function setBpm(bpm) {
    const p = cur(); if (!p) return;
    const d = Preset.decode(p.bytes, catalogs[p.device]), mode = tempoMode(p, d);
    bpm = clamp(Math.round(bpm), ...BPM_RANGE);
    if (mode === "bpm") setBytes(p, PRST.applyEdits(p.bytes, { settings: { bpm } }));
    else if (mode === "delay") {
      const t = delayTime(d);
      S.bpmShown = { id: p.id, bpm };
      setBytes(p, Preset.writeBlock(p.bytes, DLY, { values: { [DLY_TIME]: clamp(Math.round((60000 / bpm) * division()), t.min, t.max) } }));
    } else return toast("O delay deste preset não tem tempo em ms.", true);
    renderAll();
  }
  function renderCtl(p, d) {
    $("#ctlGrid").innerHTML = d.ctl.map((m, fs) => `<div class="ctl-row"><b>${d.ctl.length > 1 ? `CTL ${fs + 1}` : "CTL"}</b><div class="chips">` +
      KEY_BLOCKS.map((k) => `<button type="button" class="${(m >> k) & 1 ? "on" : ""}" data-fs="${fs}" data-k="${k}" title="${(m >> k) & 1 ? "tirar do" : "pôr no"} CTL">${esc(BLOCK_INFO[k][0])}</button>`).join("") +
      "</div></div>").join("");
    $("#expNote").hidden = p.device !== "gp50";
  }
  $("#ctlGrid").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-fs]"), p = cur(); if (!b || !p) return;
    const fs = Number(b.dataset.fs), k = Number(b.dataset.k), m = Preset.readCtl(p.bytes)[fs];
    setBytes(p, Preset.writeCtl(p.bytes, fs, m ^ (1 << k)));
    renderAll();
  });

  function renderTools(p, d) {
    const mode = tempoMode(p, d), bpm = currentBpm(p, d), t = delayTime(d);
    $("#tempoHint").textContent = mode === "bpm" ? "BPM do preset" : mode === "delay" ? "ajusta o tempo do delay" : "o delay deste preset não tem tempo";
    $("#divGroup").hidden = mode !== "delay";
    ["#btnTap", "#bpmMinus", "#bpmPlus", "#bpmRange"].forEach((s) => ($(s).disabled = !mode));
    $("#bpmOut").textContent = bpm ?? "—";
    Object.assign($("#bpmRange"), { min: BPM_RANGE[0], max: BPM_RANGE[1] });
    if (bpm != null) $("#bpmRange").value = bpm;
    $("#delayOut").textContent = !t ? (p.device === "gp50" ? "efeitos com Sync seguem este tempo" : "")
      : isSynced(t) ? `Delay ♪ ${DIVS[Math.round(t.value)]} (sincronizado)` : `Delay ${Math.round(t.value)} ms`;
    if (document.activeElement !== $("#volRange")) { $("#volRange").value = d.vol; $("#volOut").textContent = d.vol; }
  }
  function tap() {
    const now = performance.now(), btn = $("#btnTap");
    if (btn.disabled) return;
    if (S.taps.length && now - S.taps[S.taps.length - 1] > 2000) S.taps = [];
    S.taps = [...S.taps, now].slice(-5);
    btn.classList.remove("flash"); void btn.offsetWidth; btn.classList.add("flash");
    if (S.taps.length >= 2) setBpm((60000 * (S.taps.length - 1)) / (S.taps[S.taps.length - 1] - S.taps[0]));
  }
  $("#btnTap").onclick = tap;
  const nudgeBpm = (dx) => { const p = cur(); if (p) setBpm((currentBpm(p, Preset.decode(p.bytes, catalogs[p.device])) || 120) + dx); };
  $("#bpmMinus").onclick = () => nudgeBpm(-1);
  $("#bpmPlus").onclick = () => nudgeBpm(1);
  $("#bpmRange").oninput = (e) => ($("#bpmOut").textContent = e.target.value);
  $("#bpmRange").onchange = (e) => setBpm(Number(e.target.value));
  $$("#divGroup input").forEach((r) => (r.onchange = () => { const p = cur(); if (p && S.bpmShown && S.bpmShown.id === p.id) setBpm(S.bpmShown.bpm); }));
  $("#volRange").oninput = (e) => ($("#volOut").textContent = e.target.value);
  $("#volRange").onchange = (e) => {
    const p = cur(); if (!p) return;
    setBytes(p, PRST.applyEdits(p.bytes, { settings: { patch_vol: Number(e.target.value) } }));
    renderAll();
  };

  function renderEditor() {
    const p = cur();
    $("#connectHint").hidden = !!p;
    $("#editor").hidden = !p;
    $("#copySource").textContent = p ? `${PRST.readName(p.bytes)} (${PRST.profileFor(p.device).name}${p.slot != null ? ", slot " + p.slot : ""})` : "— abra um preset no Editor —";
    $("#btnExport").disabled = !p;
    $("#btnRevert").disabled = !p || !isDirty(p);
    $("#btnUndo").disabled = $("#btnUndoLib").disabled = !S.undo.length;
    const save = $("#btnSavePedal");
    save.disabled = !p || !Device.isConnected() || S.busy;
    save.classList.toggle("dirty", !!p && (isDirty(p) || (live.id === p.id && p.source !== "pedaleira")));
    if (!p) return;
    const d = Preset.decode(p.bytes, catalogs[p.device]);
    renderHead(p, d); renderChain(p, d); renderBlock(p, d); renderTools(p, d); renderCtl(p, d); renderLive(p);
  }

  // ---------- ao vivo ----------
  // Conectado, o preset do Editor que veio da pedaleira fica ao vivo sozinho. Um
  // arquivo vai para a pedaleira com "Tocar" (no slot dele, ou no preset ativo).
  // Tudo fica so na memoria de trabalho ate Salvar.
  const live = { id: null, synced: null, starting: false };
  const isLiveCurrent = () => live.id === S.current && !live.starting && Device.isLive();
  function liveBytes(p) {
    const key = Device.device().key;
    return p.device === key ? p.bytes : PRST.convert(p.bytes, key);
  }
  function renderLive(p) {
    const conn = Device.isConnected(), on = conn && live.id === p.id && !live.starting;
    const badge = $("#liveStatus");
    badge.className = "live-badge" + (on ? " on" : live.starting && live.id === p.id ? " busy" : "");
    badge.textContent = !conn ? "pedaleira desconectada" : live.starting && live.id === p.id ? "carregando na pedaleira…"
      : on ? `ao vivo · slot ${Device.activeSlot() != null ? pad2(Device.activeSlot()) : "ativo"}` : "fora da pedaleira";
    const play = $("#btnPlay");
    play.hidden = !conn || on || (live.starting && live.id === p.id);
    play.textContent = p.slot != null ? `Tocar no slot ${pad2(p.slot)}` : "Tocar no preset ativo";
  }
  function stopLive() { Device.liveStop(); live.id = live.synced = null; }
  function ensureLive() {
    const p = cur(), dev = Device.device();
    if (!p || !dev || live.starting || S.busy) return;
    if (live.id === p.id) return maybeSync();
    if (p.source === "pedaleira" && p.device === dev.key) startLive(p);
  }
  async function startLive(p) {
    const dev = Device.device();
    const bad = p.device !== dev.key ? incompatible(p.bytes, dev.key) : [];
    if (bad.length) return toast(`Não dá para tocar: usa modelo que não existe na ${dev.name} (${bad.join(", ")})`, true);
    live.starting = true; live.id = p.id; renderLive(p);
    try {
      if (p.source === "pedaleira" && p.device === dev.key && !isDirty(p)) {
        // ja esta guardado na pedaleira: so adota o que ela tem (pode ter mudado no aparelho)
        const shown = await Device.liveStart(null, p.slot, catalogs[dev.key]);
        const named = PRST.applyEdits(shown, { name: slotName(p.slot) });
        if (!same(named, p.bytes)) p.bytes = p.original = named;
      } else {
        await Device.liveStart(liveBytes(p), p.slot, catalogs[dev.key]);
      }
      live.synced = p.bytes;
      S.pedalSlot = Device.activeSlot();
    } catch (e) { stopLive(); fail(e); }
    live.starting = false;
    renderAll();
  }
  function maybeSync() {
    if (!live.id || live.starting) return;
    const p = byId(live.id);
    if (!p || S.current !== live.id) return;
    if (p.bytes !== live.synced) { live.synced = p.bytes; Device.liveSync(liveBytes(p)).catch(fail); }
  }
  $("#btnPlay").onclick = () => { const p = cur(); if (p && Device.isConnected()) startLive(p); };

  // Abre um slot da pedaleira no Editor (null = o preset que ja esta ativo nela).
  async function openSlot(slot) {
    const dev = Device.device(); if (!dev || live.starting) return;
    const old = slot != null ? byId(devId(dev.key, slot)) : null;
    if (old && isDirty(old)) { S.current = old.id; S.block = S.block ?? AMP; renderAll(); return; } // ensureLive manda as alteracoes
    stopLive();
    live.starting = true; renderPicker();
    try {
      const shown = await Device.liveStart(null, slot, catalogs[dev.key]);
      const s = Device.activeSlot();
      const p = addPreset({ id: devId(dev.key, s), slot: s, bytes: PRST.applyEdits(shown, { name: slotName(s) }), source: "pedaleira" });
      sortPresets();
      live.id = S.current = p.id; live.synced = p.bytes; S.pedalSlot = s;
    } catch (e) { stopLive(); fail(e); }
    live.starting = false;
    renderAll();
  }

  // ---------- salvar na pedaleira ----------
  $("#btnSavePedal").onclick = async () => {
    const p = cur(), dev = Device.device();
    if (!p || !dev) return;
    if (live.id !== p.id || live.starting) { await startLive(p); if (live.id !== p.id) return; }
    const slot = Device.activeSlot();
    if (slot == null) return toast("Não consegui saber qual slot está ativo na pedaleira.", true);
    $("#saveSlot").textContent = pad2(slot);
    $("#saveName").value = Device.saveName(Bulk.cleanName(PRST.readName(p.bytes))).replace(/[^A-Za-z0-9 -]/g, "");
    $("#saveDlg").returnValue = "";
    $("#saveDlg").showModal();
    $("#saveName").select();
  };
  $("#saveDlg").addEventListener("close", () => {
    if ($("#saveDlg").returnValue === "ok") saveLive(Device.activeSlot(), $("#saveName").value);
  });
  async function saveLive(slot, rawName) {
    const p = byId(live.id), dev = Device.device();
    const name = Device.saveName(Bulk.cleanName(rawName)).replace(/[^A-Za-z0-9 -]/g, "").trim();
    if (!p || !dev || slot == null) return;
    if (!name) return toast("Dê um nome ao preset.", true);
    S.busy = true; renderAll();
    try {
      const base = Device.baseline();
      if (base) { S.backups.push({ slot, device: dev.key, bytes: PRST.applyEdits(base, { name: slotName(slot) }), when: new Date() }); renderBackups(); }
      const expected = PRST.applyEdits(liveBytes(p), { name });
      await Device.liveSync(expected); // garante que a pedaleira tem tudo antes de salvar
      await Device.save(slot, name);
      const r = await Device.verify(slot, expected, catalogs[dev.key]);
      await refreshNames();
      const id = devId(dev.key, slot);
      if (p.id === id) {
        p.original = r.readBack;
        if (r.verified) p.bytes = r.readBack;
      } else {
        addPreset({ id, slot, bytes: r.readBack, source: "pedaleira" }); sortPresets();
      }
      const saved = byId(id);
      Device.liveAdopt(r.readBack, slot, catalogs[dev.key]);
      live.id = S.current = id; live.synced = saved.bytes; S.pedalSlot = slot;
      toast(r.verified ? `Salvo no slot ${pad2(slot)} ("${name}") e conferido.`
        : `Salvo no slot ${pad2(slot)}, mas a releitura difere:\n${r.diff.slice(0, 6).join("\n")}${r.diff.length > 6 ? "\n…" : ""}`, !r.verified);
    } catch (e) { fail(e); }
    S.busy = false;
    renderAll();
  }

  // ---------- edicao em massa ----------
  const targets = () => S.presets.filter((p) => S.selected.has(p.id));
  let op = "rename";
  $$(".subtabs button").forEach((b) => (b.onclick = () => {
    op = b.dataset.op;
    $$(".subtabs button").forEach((x) => x.classList.toggle("active", x === b));
    $$(".op").forEach((f) => f.classList.toggle("active", f.id === `op-${op}`));
    S.plan = null; renderBulk();
  }));
  $$("form.op").forEach((f) => { f.onsubmit = (e) => e.preventDefault(); f.addEventListener("change", () => { S.plan = null; renderBulk(); }); f.addEventListener("input", () => { S.plan = null; $("#btnApply").disabled = true; }); });
  $("#ctlBulkBlocks").innerHTML = KEY_BLOCKS.map((k) => `<label><input type="checkbox" value="${k}">${esc(BLOCK_INFO[k][0])}</label>`).join("");
  for (const f of ["#op-copy", "#op-param", "#op-toggle"]) {
    $(`${f} [name=block]`).innerHTML = Preset.BLOCKS.map((n, k) => `<option value="${k}">${n}</option>`).join("");
  }

  // modelos que aparecem no bloco k dos presets selecionados
  function modelsInSelection(k) {
    const seen = new Map();
    for (const p of targets()) {
      const b = Preset.decode(p.bytes, catalogs[p.device]).blocks[k];
      const c = seen.get(b.fxid) || { fxid: b.fxid, label: b.model, entry: b.entry, n: 0 };
      c.n++; seen.set(b.fxid, c);
    }
    return [...seen.values()].sort((a, z) => z.n - a.n);
  }

  // todos os efeitos com parametros que o bloco k aceita, na(s) pedaleira(s) dos
  // presets selecionados (ou do preset aberto); n = quantos selecionados usam cada um
  function allModels(k) {
    const used = new Map(modelsInSelection(k).map((m) => [m.fxid, m.n]));
    const devs = new Set(targets().map((p) => p.device));
    if (!devs.size) devs.add(cur() ? cur().device : (Device.device() || { key: "gp5" }).key);
    const out = new Map();
    for (const dev of devs) for (const m of catalogs[dev].models(Preset.BLOCKS[k])) {
      if (!m.params.length || out.has(m.fxid)) continue;
      out.set(m.fxid, { fxid: m.fxid, entry: m, label: catalogs[dev].label(m.fxid), n: used.get(m.fxid) || 0 });
    }
    return [...out.values()];
  }

  function renderBulk() {
    const fRename = $("#op-rename");
    $$("[data-mode]", fRename).forEach((d) => (d.hidden = d.dataset.mode !== fRename.mode.value));

    const fCopy = $("#op-copy"), kc = Number(fCopy.block.value), src = cur();
    if (src) {
      const b = Preset.decode(src.bytes, catalogs[src.device]).blocks[kc];
      $("#copyWhat").textContent = `Vai copiar: ${b.model} (${b.active ? "ligado" : "desligado"}) — ` +
        (b.params.map((p) => `${p.name} ${+p.value.toFixed(2)}`).join(", ") || "sem parâmetros");
    } else $("#copyWhat").textContent = "";
    const checked = new Set($$("#copyOnly input:checked").map((i) => Number(i.value)));
    $("#copyOnly").innerHTML = modelsInSelection(kc).map((m) =>
      `<label><input type="checkbox" value="${m.fxid}" ${checked.has(m.fxid) ? "checked" : ""}> ${esc(m.label)} <span class="muted">(${m.n})</span></label>`).join("") || `<span class="muted">selecione presets</span>`;

    const fParam = $("#op-param"), kp = Number(fParam.block.value);
    const models = allModels(kp);
    const prevModel = fParam.model.value;
    fParam.model.innerHTML = models.map((m) => `<option value="${m.fxid}" title="${esc(m.entry.origin || "")}">${esc(m.label)}${m.n ? ` — usado em ${m.n}` : ""}</option>`).join("");
    if (!models.some((m) => String(m.fxid) === prevModel)) { const used = models.find((m) => m.n); if (used) fParam.model.value = used.fxid; }
    if (models.some((m) => String(m.fxid) === prevModel)) fParam.model.value = prevModel;
    const entry = (models.find((m) => String(m.fxid) === fParam.model.value) || {}).entry;
    const prevParam = fParam.param.value;
    fParam.param.innerHTML = ((entry && entry.params) || []).map((p) => `<option value="${p.algId}">${esc(p.name)} (${p.min}–${p.max})</option>`).join("");
    if ([...fParam.param.options].some((o) => o.value === prevParam)) fParam.param.value = prevParam;

    renderPlan();
  }

  function buildPlan() {
    const t = targets();
    if (!t.length) throw new Error("Selecione presets na lista (caixas à esquerda).");
    if (op === "rename") {
      const f = $("#op-rename");
      return Bulk.planRename(t, { mode: f.mode.value, template: f.template.value, start: f.start.value, find: f.find.value, replace: f.replace.value, caseSensitive: f.caseSensitive.checked, caixa: f.caixa.value });
    }
    if (op === "copy") {
      const src = cur();
      if (!src) throw new Error("Abra no Editor o preset de origem (clique nele na lista).");
      const only = new Set($$("#copyOnly input:checked").map((i) => Number(i.value) >>> 0));
      return Bulk.planCopyBlock(t, { source: src, k: Number($("#op-copy").block.value), withActive: $("#op-copy").withActive.checked, onlyModels: only }, catalogs);
    }
    if (op === "param") {
      const f = $("#op-param");
      if (!f.model.value || f.param.value === "") throw new Error("Escolha bloco, efeito e parâmetro.");
      return Bulk.planSetParam(t, { k: Number(f.block.value), fxid: Number(f.model.value), algId: Number(f.param.value), value: Number(f.value.value), mode: f.mode.value, swap: f.swap.checked }, catalogs);
    }
    if (op === "ctl") {
      const f = $("#op-ctl"), mask = $$("#ctlBulkBlocks input:checked").reduce((m, i) => m | (1 << Number(i.value)), 0);
      if (!mask && f.mode.value !== "definir") throw new Error("Marque os blocos.");
      return Bulk.planCtl(t, { fs: Number(f.fs.value), mode: f.mode.value, mask });
    }
    const f = $("#op-toggle");
    return Bulk.planToggle(t, { k: Number(f.block.value), active: f.active.value === "1" });
  }

  function renderPlan() {
    const out = $("#planOut");
    $("#btnApply").disabled = !(S.plan && S.plan.some((r) => r.change));
    if (!S.plan) { out.innerHTML = ""; return; }
    const n = S.plan.filter((r) => r.change).length;
    out.innerHTML = `<p><b>${n}</b> de ${S.plan.length} preset(s) vão mudar.</p>
      <table class="plan"><thead><tr><th>Preset</th><th>Antes</th><th>Depois</th><th>Obs.</th></tr></thead><tbody>` +
      S.plan.map((r) => {
        const p = byId(r.id);
        return `<tr class="${r.change ? "change" : "skip"}"><td>${p.slot ?? ""} ${esc(PRST.readName(p.bytes))}</td><td>${esc(r.before)}</td><td>${esc(r.after)}</td><td>${esc(r.note || "")}</td></tr>`;
      }).join("") + "</tbody></table>";
  }

  $("#btnPreview").onclick = () => { try { S.plan = buildPlan(); renderPlan(); } catch (e) { fail(e); } };
  $("#btnApply").onclick = () => {
    if (!S.plan) return;
    const snap = new Map();
    for (const r of S.plan.filter((r) => r.change)) { const p = byId(r.id); snap.set(p.id, p.bytes); p.bytes = r.bytes; }
    pushUndo(snap);
    toast(`${snap.size} preset(s) alterado(s). Use "Salvar selecionados" ou "Gravar selecionados na pedaleira" para guardar.`);
    S.plan = null; renderAll();
  };

  // ---------- pedaleira: conexao ----------
  function setConnected(dev) {
    document.body.dataset.conn = dev ? "on" : "off";
    $("#brandModel").textContent = dev ? dev.name : "GP-5 / GP-50";
    $("#connLabel").textContent = dev ? `conectada · ${dev.transport} · ${dev.port}` : "desconectada";
    $("#btnRead").disabled = !dev;
    if (!dev) { S.devNames = null; S.pedalSlot = null; }
    renderPicker();
  }
  function renderPicker() {
    const sel = $("#slotSelect"), on = Device.isConnected() && !!S.devNames;
    sel.disabled = $("#slotPrev").disabled = $("#slotNext").disabled = !on || live.starting || S.busy;
    if (!on) { sel.innerHTML = `<option>${Device.isConnected() ? "lendo…" : "— conecte a pedaleira —"}</option>`; return; }
    const html = S.devNames.map((n) => `<option value="${n.slot}">${pad2(n.slot)}  ${esc(n.name)}</option>`).join("");
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
    if (S.pedalSlot != null) sel.value = S.pedalSlot;
  }
  // o seletor do topo e o preset tocando na pedaleira: abre no Editor
  $("#slotSelect").onchange = (e) => { showView("viewEditor"); openSlot(Number(e.target.value)); };
  const stepSlot = (d) => { if (!$("#slotSelect").disabled) { showView("viewEditor"); openSlot(((S.pedalSlot ?? 0) + d + 100) % 100); } };
  $("#slotPrev").onclick = () => stepSlot(-1);
  $("#slotNext").onclick = () => stepSlot(1);

  function renderNames(names) {
    $("#devNames").innerHTML = names.map((n) => `<li class="${n.empty ? "empty" : ""}">${esc(n.name)}</li>`).join("");
  }
  async function refreshNames() { const names = await Device.readNames(); S.devNames = names; renderNames(names); renderPicker(); return names; }

  async function connectWith(kind) {
    try {
      stopLive();
      document.body.dataset.conn = "busy"; $("#connLabel").textContent = "conectando…";
      const dev = await Device.connect(kind);
      S.devNames = null; S.pedalSlot = null;
      setConnected(dev);
      await refreshNames();
      try {
        S.banks = { device: dev.key, ...(await Device.readBanks()) };
        catalogs[dev.key].setBankNames(S.banks);
      } catch (e) { console.warn(e); $("#banks").innerHTML = `<p class="warn">Não consegui ler IRs/SnapTones: ${esc(e.message)}</p>`; }
      showView("viewEditor");
      await openSlot(null); // abre o preset que esta ativo na pedaleira
      toast(`${dev.name} conectada pelo ${dev.transport}.`);
    } catch (e) {
      setConnected(Device.isConnected() ? Device.device() : null);
      if (e.name !== "NotFoundError") fail(e); // NotFoundError: fechou a janela de escolha do Bluetooth
    }
  }
  $("#btnConnect").onclick = () => connectWith("usb");
  $("#btnConnectBle").onclick = () => connectWith("ble");
  $("#btnDisconnect").onclick = () => { stopLive(); Device.disconnect(); setConnected(null); renderAll(); };
  Device.onDisconnect(() => {
    stopLive(); setConnected(null); renderAll();
    toast("Pedaleira desconectada.", true);
  });

  // ---------- acompanhar a pedaleira ----------
  // Trocou de preset (ou de modelo) na pedaleira: o editor rele e mostra. Se a versao
  // da lista tem alteracoes nao gravadas, ela fica e volta a ser mandada (ao vivo).
  function onPedal({ slot, bytes }) {
    const dev = Device.device();
    if (!$("#follow").checked || S.busy || live.starting || slot == null || !dev) return;
    const id = devId(dev.key, slot), changedSlot = slot !== S.pedalSlot;
    let p = byId(id);
    S.pedalSlot = slot;
    if (!p) { p = addPreset({ id, slot, bytes: PRST.applyEdits(bytes, { name: slotName(slot) }), source: "pedaleira" }); sortPresets(); }
    else if (!(changedSlot && isDirty(p))) {
      setBytes(p, PRST.applyEdits(bytes, { name: PRST.readName(p.bytes) }), { undo: !changedSlot }); // o corpo lido nao traz o nome
      if (changedSlot) p.original = p.bytes;
    }
    Device.liveAdopt(bytes, slot, catalogs[dev.key]);
    live.id = S.current = id; live.synced = changedSlot && isDirty(p) ? null : p.bytes;
    S.plan = null; renderAll();
  }
  // Knob, liga/desliga ou ordem mexidos na pedaleira: aplica no preset ao vivo.
  function onPedalEdit(ev) {
    const p = byId(live.id);
    if (!$("#follow").checked || S.busy || live.starting || !p) return;
    let b = p.bytes;
    if (ev.type === "param") b = Preset.writeBlock(b, ev.k, { values: { [ev.alg]: ev.value } });
    else if (ev.type === "toggle") b = Preset.writeBlock(b, ev.k, { active: ev.active });
    else if (ev.type === "order") b = PRST.applyEdits(b, { order: ev.order });
    setBytes(p, b, { undo: false });
    live.synced = p.bytes;
    if (ev.k != null && S.current === p.id && ev.type !== "order") S.block = ev.k;
    renderAll();
  }
  const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, "0")).join(" ");
  function logPedal(ev) {
    const what = ev.payload ? `cmd ${hex([ev.cmd])} · ${hex(ev.payload)}` : ev.program != null ? `Program Change ${ev.program}` : hex(ev.raw);
    S.pedalLog = [`${new Date().toLocaleTimeString()}  ${what}${ev.ownEcho ? "  (logo após comando do editor)" : ""}`, ...S.pedalLog].slice(0, 80);
    $("#pedalLog").textContent = S.pedalLog.join("\n");
  }
  Device.onPedalChange(onPedal, logPedal, onPedalEdit);

  // ---------- pedaleira: ler e gravar em lote ----------
  function parseRange(txt) {
    const out = new Set();
    for (const part of txt.split(",").map((s) => s.trim()).filter(Boolean)) {
      const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
      if (!m) throw new Error(`faixa inválida: "${part}"`);
      const a = Number(m[1]), z = m[2] != null ? Number(m[2]) : a;
      for (let i = Math.min(a, z); i <= Math.max(a, z); i++) if (i <= 99) out.add(i);
    }
    return [...out].sort((a, z) => a - z);
  }

  $("#btnRead").onclick = async () => {
    try {
      const names = S.devNames || await refreshNames();
      const slots = $("#slotRange").value.trim() ? parseRange($("#slotRange").value) : names.filter((n) => !n.empty).map((n) => n.slot);
      const key = Device.device().key;
      const dirty = slots.filter((s) => { const p = byId(devId(key, s)); return p && isDirty(p); });
      if (dirty.length && !confirm(`Os slots ${dirty.join(", ")} têm alterações não gravadas que serão perdidas. Continuar?`)) return;
      stopLive();
      S.stop = false; S.busy = true; renderAll();
      const res = await Device.readSlots(slots, (i, total, slot) => progress(i, total, slot != null ? `Lendo slot ${slot} (${i + 1}/${total})…` : ""), () => S.stop);
      for (const r of res) addPreset({ id: devId(key, r.slot), slot: r.slot, bytes: r.bytes, source: "pedaleira" });
      sortPresets();
      toast(`${res.length} preset(s) lido(s) da pedaleira.`);
    } catch (e) { progress(1, 1); fail(e); }
    S.busy = false;
    renderAll();
  };

  $("#btnWrite").onclick = async () => {
    const dev = Device.device();
    const sel = targets();
    if (!sel.length) return toast("Selecione os presets que quer gravar.", true);
    const noSlot = sel.filter((p) => p.slot == null);
    if (noSlot.length) return toast(`Defina o slot (no Editor) de: ${noSlot.map((p) => PRST.readName(p.bytes)).join(", ")}`, true);
    const slots = sel.map((p) => p.slot);
    if (new Set(slots).size !== slots.length) return toast("Há dois presets selecionados para o mesmo slot.", true);
    for (const p of sel) {
      const bad = p.device !== dev.key ? incompatible(p.bytes, dev.key) : [];
      if (bad.length) return toast(`"${PRST.readName(p.bytes)}" usa modelo que não existe na ${dev.name}: ${bad.join(", ")}`, true);
    }
    const names = S.devNames || [];
    const lines = sel.map((p) => `slot ${p.slot}: "${(names.find((n) => n.slot === p.slot) || {}).name ?? "?"}" → "${PRST.readName(p.bytes)}"`);
    if (!confirm(`Gravar ${sel.length} preset(s) na ${dev.name}? Isso SOBRESCREVE:\n\n${lines.join("\n")}\n\nO conteúdo atual de cada slot é guardado antes, como backup.${dev.key === "gp5" ? "\n\nNa GP-5 o nome fica com até 10 caracteres." : ""}`)) return;

    stopLive();
    S.stop = false; S.busy = true; renderAll();
    const report = [];
    try {
      for (let i = 0; i < sel.length; i++) {
        if (S.stop) break;
        const p = sel[i];
        progress(i, sel.length, `Gravando slot ${p.slot} (${i + 1}/${sel.length})…`);
        const [backup] = await Device.readSlots([p.slot]);
        S.backups.push({ slot: p.slot, device: dev.key, bytes: backup.bytes, when: new Date() });
        renderBackups();
        const r = await Device.writeSlot(p.slot, p.bytes, catalogs[dev.key]);
        if (r.verified) {
          addPreset({ id: devId(dev.key, p.slot), slot: p.slot, bytes: r.readBack, source: "pedaleira" });
          if (p.source === "arquivo") p.original = p.bytes; else p.original = p.bytes = r.readBack;
        }
        report.push(`slot ${p.slot}: ${r.verified ? "ok, conferido" : explainMismatch(r, backup.bytes, dev.key)}`);
        if (!r.verified) break;
      }
    } catch (e) { report.push(`erro: ${e.message}`); }
    progress(1, 1);
    S.busy = false;
    sortPresets();
    await refreshNames().catch(() => {});
    renderAll();
    toast(report.join("\n"), report.some((l) => !l.includes("ok, conferido")));
  };

  // Gravacao nao conferida: diz se a pedaleira ignorou (slot igual ao backup) ou o que mudou.
  function explainMismatch(r, before, key) {
    if (!Preset.diff(before, r.readBack, catalogs[key], { name: false }).length) return `ATENÇÃO: a pedaleira não aceitou a gravação (${r.method}), o slot continua como era`;
    return `ATENÇÃO: releitura diferente (${r.method}): ${r.diff.slice(0, 4).join("; ")}${r.diff.length > 4 ? "…" : ""}. Detalhes no console (Cmd+Option+J)`;
  }

  function renderBackups() {
    $("#backups").innerHTML = S.backups.map((b) => `<li>slot ${b.slot}: ${esc(PRST.readName(b.bytes))} — ${b.when.toLocaleTimeString()}</li>`).join("") || "<li>nenhum</li>";
    $("#btnSaveBackups").disabled = !S.backups.length;
  }
  $("#btnSaveBackups").onclick = async () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    try {
      await saveToFolder(S.backups.map((b) => ({ name: `backup-${stamp}-${pad2(b.slot)}-${safeName(PRST.readName(b.bytes))}.prst`, bytes: b.bytes })));
      toast("Backups salvos.");
    } catch (e) { if (e.name !== "AbortError") fail(e); }
  };

  // presets (do mesmo aparelho) cujo bloco k aponta para fxid
  const usersOf = (k, fxid) => S.presets.filter((p) => p.device === S.banks.device && Preset.readBlock(p.bytes, k).fxid === fxid >>> 0);
  function renderBanks() {
    if (!S.banks) return;
    const row = (k, fxid, label, free) => {
      const n = usersOf(k, fxid).length;
      return `<tr class="${free ? "free" : ""}"><td>${esc(label)}</td><td>${n ? `<button class="link" data-k="${k}" data-fx="${fxid}">${n}</button>` : ""}</td></tr>`;
    };
    const st = S.banks.snaptone.map((name, i) => row(NS, (0x0f000000 | i) >>> 0, `${i}${i >= 50 ? " (usuário)" : ""} · ${name || "—"}`, !S.banks.occupied[i]));
    const ir = S.banks.ir.map((name, i) => row(CAB, 0x0a100000 + i, `${i + 1} · ${name}`, name === `User IR ${i + 1}`));
    $("#banks").innerHTML =
      `<table><thead><tr><th>User IR</th><th>Usado em</th></tr></thead><tbody>${ir.join("")}</tbody></table>` +
      `<table><thead><tr><th>SnapTone</th><th>Usado em</th></tr></thead><tbody>${st.join("")}</tbody></table>`;
  }
  $("#banks").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-k]"); if (!b) return;
    S.selected = new Set(usersOf(Number(b.dataset.k), Number(b.dataset.fx)).map((p) => p.id));
    S.plan = null; showView("viewLibrary"); renderAll();
  });

  // ---------- telas ----------
  function showView(id) {
    document.body.dataset.view = id;
    $$(".views button").forEach((b) => b.classList.toggle("active", b.dataset.view === id));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === id));
    if (id === "viewLibrary") renderBulk();
  }
  $$(".views button").forEach((b) => (b.onclick = () => showView(b.dataset.view)));
  document.addEventListener("click", (e) => { const a = e.target.closest("[data-goto]"); if (a) { e.preventDefault(); showView(a.dataset.goto); } });

  // ---------- teclado ----------
  // 1..0 liga/desliga blocos, espaco = tap, PgUp/PgDn troca de preset, Ctrl/Cmd+Z desfaz.
  document.addEventListener("keydown", (e) => {
    const typing = e.target.matches("input:not([type=range]):not([type=checkbox]):not([type=radio]), select, textarea") || $("#saveDlg").open;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); undo(); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey || !$("#viewEditor").classList.contains("active")) return;
    if (e.key === "PageUp") { e.preventDefault(); stepSlot(-1); }
    else if (e.key === "PageDown") { e.preventDefault(); stepSlot(1); }
    else if (e.key === " " && cur()) { e.preventDefault(); tap(); }
    else if (/^[0-9]$/.test(e.key) && cur()) { const k = KEY_BLOCKS[(Number(e.key) + 9) % 10]; S.block = k; toggleBlock(k); }
  });

  // ---------- tema ----------
  const THEMES = [["", "automático"], ["light", "claro"], ["dark", "escuro"]];
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    $("#btnTheme").title = `Tema: ${THEMES.find(([k]) => k === t)[1]} (clique para trocar)`;
    try { t ? localStorage.setItem("tema", t) : localStorage.removeItem("tema"); } catch (e) {}
  }
  $("#btnTheme").onclick = () => {
    const c = document.documentElement.dataset.theme || "";
    applyTheme(THEMES[(THEMES.findIndex(([k]) => k === c) + 1) % THEMES.length][0]);
  };
  applyTheme(document.documentElement.dataset.theme || "");

  function renderAll() {
    renderTable(); renderEditor(); renderBanks(); renderPicker();
    if ($("#viewLibrary").classList.contains("active")) renderBulk();
    ensureLive();
  }
  window.addEventListener("beforeunload", (e) => { if (S.presets.some(isDirty)) { e.preventDefault(); e.returnValue = ""; } });
  // Sem Web MIDI / Web Bluetooth os botoes ficam inativos; no celular nao ha "title" (hover),
  // entao o motivo aparece no cartao de conexao.
  const noMidi = !navigator.requestMIDIAccess, noBle = !navigator.bluetooth;
  if (noMidi) { $("#btnConnect").disabled = true; $("#btnConnect").title = "Este navegador não tem Web MIDI (use Chrome ou Edge)"; }
  if (noBle) { $("#btnConnectBle").disabled = true; $("#btnConnectBle").title = "Este navegador não tem Web Bluetooth (use Chrome ou Edge)"; }
  if (noMidi || noBle) {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const what = noMidi && noBle ? "USB nem Bluetooth" : noMidi ? "USB (Web MIDI)" : "Bluetooth (Web Bluetooth)";
    $("#noSupport").innerHTML = ios
      ? `<b>Este navegador não conecta por ${what}.</b> No iPhone e no iPad todos os navegadores (Safari, Chrome, Edge) usam o motor do Safari, que não tem Web MIDI nem Web Bluetooth. Use o <b>Chrome</b> ou o <b>Edge</b> num computador (Mac ou Windows) ou num celular <b>Android</b>. No iPhone, o navegador gratuito <b>Bluefy</b> tem Web Bluetooth e pode conectar por Bluetooth (ainda não testado).`
      : `<b>Este navegador não conecta por ${what}.</b> Use o <b>Chrome</b> ou o <b>Edge</b> atualizados (no computador ou no Android).`;
    $("#noSupport").hidden = false;
  }
  renderAll();
})().catch((e) => { console.error(e); alert("Erro ao iniciar o editor: " + e.message); });
