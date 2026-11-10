"use strict";
/*
 * device.js — operacoes de alto nivel com a pedaleira via USB (Web MIDI), em
 * cima de lib/webmidi_device.js (leitura) e lib/webmidi_write.js (gravacao).
 *
 * Conexao por USB (Web MIDI) ou Bluetooth (Web BLE-MIDI): o protocolo e o mesmo,
 * so muda o transporte (lib/webmidi_device.js).
 *
 * Gravacao: converte para o formato do aparelho conectado, grava (ver writeSlot)
 * e rele o slot para conferir.
 */
(function (root) {
  const { PRST, WebMidiDevice: Dev, WebMidiWrite: Write } = root;

  // kind: "usb" | "ble"
  async function connect(kind = "usb") {
    stopFollow();
    return kind === "ble" ? Dev.connectBle() : Dev.connect();
  }

  // Le os nomes dos 100 slots. Os vazios vem com o nome de fabrica ("GP-50"/"GP-5").
  async function readNames() {
    const names = await Dev.readNames();
    return names.map((n) => ({ ...n, empty: /^GP-50?$/i.test(n.name) }));
  }

  // Nomes dos SnapTones (seletor 0x24) e User IRs (0x20). Os dois blocos terminam
  // em registros de 16 bytes: 80 SnapTones (antes deles, 80 bytes de ocupacao) e 20 IRs.
  const records = (blob, n) => {
    const start = blob.length - n * 16, out = [];
    for (let i = 0; i < n; i++) {
      let s = "";
      for (let j = start + i * 16; j < start + (i + 1) * 16 && blob[j]; j++) s += String.fromCharCode(blob[j]);
      out.push(s.trim());
    }
    return out;
  };
  async function readBanks() {
    const st = await Dev.readBankBlob(0x24);
    const ir = await Dev.readBankBlob(0x20);
    if (st.length < 80 * 17 || ir.length < 20 * 16) throw new Error(`leitura de SnapTones/IRs incompleta (${st.length}/${ir.length} bytes)`);
    const occupied = Array.from(st.slice(st.length - 80 * 17, st.length - 80 * 16), (b) => b !== 0);
    return { snaptone: records(st, 80), occupied, ir: records(ir, 20) };
  }

  // Le slots um por um (o aparelho nao tem leitura em lote). onProgress(i, total, slot)
  async function readSlots(slots, onProgress = () => {}, shouldStop = () => false) {
    const out = [];
    for (let i = 0; i < slots.length; i++) {
      if (shouldStop()) break;
      onProgress(i, slots.length, slots[i]);
      out.push({ slot: slots[i], bytes: await Dev.readSlotPrst(slots[i]) });
    }
    onProgress(slots.length, slots.length, null);
    return out;
  }

  // ---------- gravar ----------
  // GP-5: carrega o preset na memoria de trabalho (ao vivo) e salva com o comando
  // nativo 0x4A, o mesmo do editor rvalladares.com/gp5/gpeditor, que grava na GP-5
  // por Bluetooth e USB. GP-50: fluxo de importacao do Valeton Suite (0x1D),
  // confirmado em capturas. Nos dois casos rele o slot e confere o que se ouve.
  async function writeSlot(slot, bytes, deviceCatalog) {
    const dev = Dev.device();
    if (!dev) throw new Error("pedaleira não conectada");
    let data = bytes;
    if (PRST.detect(bytes).key !== dev.key) data = PRST.convert(bytes, dev.key); // lanca erro se houver modelo incompativel
    let res;
    if (dev.key === "gp5") {
      data = PRST.applyEdits(data, { name: saveName(PRST.readName(data)) });
      await liveStart(data, slot, deviceCatalog);
      await save(slot, PRST.readName(data));
      liveStop();
      res = { method: "salvar (0x4A)" };
    } else {
      res = { method: "importação (0x1D)", ...(await Write.writeSlot(slot, data, { confirm: true })) };
    }
    return { ...res, ...(await verify(slot, data, deviceCatalog)) };
  }

  // Rele o slot e compara com o que devia estar la. diff: lista legivel do que mudou.
  async function verify(slot, data, deviceCatalog) {
    await Dev.readNames(); // o nome pode ter mudado
    const back = await Dev.readSlotPrst(slot);
    const diff = Preset.diff(data, back, deviceCatalog);
    if (diff.length) console.warn(`[gravação] slot ${slot}: releitura diferente`, { diff, enviado: Array.from(data), relido: Array.from(back) });
    return { verified: !diff.length, diff, written: data, readBack: back };
  }

  // Nome aceito pelo comando de salvar: ate 10 caracteres ASCII.
  const saveName = (name) => String(name).replace(/[^\x20-\x7e]/g, "").trim().slice(0, Dev.SAVE_NAME_LEN);

  // ---------- edicao ao vivo ----------
  // `shown` e o que acreditamos estar na memoria de trabalho da pedaleira. sync()
  // compara com o preset da tela e manda so as diferencas: modelo, liga/desliga,
  // os parametros que o catalogo conhece, ordem da cadeia, volume, BPM e CTL.
  // O nome so vai para a pedaleira ao salvar.
  const { Preset } = root;
  let shown = null, catalog = null, queue = Promise.resolve(), activeSlot = null;
  let baseline = null; // o que estava guardado no slot quando ele foi carregado (backup ao salvar)

  // Seleciona o slot (se houver) e le o que ficou ativo. Depois manda o preset da
  // tela; com bytes = null so adota o que esta na pedaleira e devolve esses bytes.
  async function liveStart(bytes, slot, deviceCatalog) {
    catalog = deviceCatalog;
    if (slot != null) await Dev.selectSlot(slot);
    // Confere que a pedaleira trocou mesmo: se o editor achar que esta num slot e ela
    // estiver noutro, salvar grava a memoria de trabalho errada com o nome do preset
    // da tela (foi o que deixou nome e efeitos em slots vizinhos na GP-50).
    activeSlot = await Dev.readCurrentSlot();
    if (slot != null && activeSlot !== slot) {
      shown = null;
      throw new Error(`A pedaleira não trocou para o slot ${slot} (está no ${activeSlot ?? "?"}). Tente de novo.`);
    }
    shown = await Dev.readActivePrst("");
    baseline = slot != null ? Uint8Array.from(shown) : null;
    if (bytes == null) return Uint8Array.from(shown);
    return liveSync(bytes);
  }
  // A pedaleira acabou de carregar `bytes` no slot (lido por readPedal): passa a ser o ao vivo.
  function liveAdopt(bytes, slot, deviceCatalog) { catalog = deviceCatalog; shown = Uint8Array.from(bytes); baseline = Uint8Array.from(bytes); activeSlot = slot; }
  const liveStop = () => { shown = null; };

  // Salva a memoria de trabalho (com tudo que ja foi mandado) no slot.
  // O 0x4A grava o que estiver na memoria de trabalho: so salva se a pedaleira
  // ainda estiver no slot que o editor carregou (pode ter sido trocado nela).
  async function save(slot, name) {
    await queue.catch(() => {});
    if (paramLoop) await paramLoop;
    const now = await Dev.readCurrentSlot();
    if (now !== slot) throw new Error(`A pedaleira está no slot ${now ?? "?"}, não no ${slot}. Nada foi salvo: abra o slot ${slot} de novo e salve.`);
    await Dev.live.save(slot, saveName(name));
  }

  const f32At = (b, k, alg) => new DataView(b.params.buffer).getFloat32(alg * 4, true);

  function liveSync(target) {
    queue = queue.then(async () => {
      if (paramLoop) await paramLoop;
      if (!shown) return 0;
      let sent = 0, modelChanged = false;
      for (let k = 0; k < Preset.BLOCKS.length; k++) {
        const want = Preset.readBlock(target, k);
        if (Preset.readBlock(shown, k).fxid !== want.fxid) { await Dev.live.model(k, want.fxid); sent++; modelChanged = true; }
      }
      if (modelChanged) shown = await Dev.readActivePrst(""); // o aparelho voltou os parametros ao padrao
      for (let k = 0; k < Preset.BLOCKS.length; k++) {
        const have = Preset.readBlock(shown, k), want = Preset.readBlock(target, k);
        for (const p of (catalog.get(want.fxid) || { params: [] }).params) {
          const v = f32At(want, k, p.algId);
          if (Math.abs(f32At(have, k, p.algId) - v) > 1e-6) { await Dev.live.param(k, p.algId, v); sent++; }
        }
        if (have.active !== want.active) { await Dev.live.toggle(k, want.active); sent++; }
      }
      const order = PRST.readOrder(target);
      if (order.join() !== PRST.readOrder(shown).join()) { await Dev.live.order(order); sent++; }
      const [vol, bpm] = PRST.readVolBpm(target), [vol0, bpm0] = PRST.readVolBpm(shown);
      if (vol !== vol0) { await Dev.live.volume(vol); sent++; }
      if (bpm !== bpm0) { await Dev.live.bpm(bpm); sent++; }
      // CTL: a GP-50 recebe as duas mascaras inteiras, com os bits acima do 9 como
      // estao no preset (a propria pedaleira os mantem; o significado e desconhecido);
      // a GP-5, bloco por bloco.
      const ctl = Preset.readCtl(target), ctl0 = Preset.readCtl(shown);
      if (Dev.device().key === "gp50") {
        if (ctl[0] !== ctl0[0] || ctl[1] !== ctl0[1]) { await Dev.live.ctlMasks(PRST.readFootswitches(target)); sent++; }
      } else {
        for (let k = 0; k < Preset.BLOCKS.length; k++) {
          const on = (ctl[0] >> k) & 1;
          if (on !== ((ctl0[0] >> k) & 1)) { await Dev.live.ctl(0, k, !!on); sent++; }
        }
      }
      shown = Uint8Array.from(target);
      return sent;
    }).catch((e) => { console.error(e); throw e; });
    return queue;
  }

  // Caminho rapido para o knob sendo arrastado: manda so o valor mais recente.
  const pendingParam = new Map();
  let paramLoop = null;
  function liveParam(k, alg, value) {
    if (!shown) return;
    pendingParam.set(`${k}:${alg}`, [k, alg, value]);
    if (paramLoop) return;
    paramLoop = (async () => {
      while (pendingParam.size) {
        const [key, [kk, aa, vv]] = pendingParam.entries().next().value;
        pendingParam.delete(key);
        await Dev.live.param(kk, aa, vv);
        shown = Preset.writeBlock(shown, kk, { values: { [aa]: vv } });
      }
      paramLoop = null;
    })();
  }

  // ---------- mudancas feitas na propria pedaleira ----------
  // A pedaleira avisa o que se mexe nela espelhando os comandos do editor:
  // [0x12, 0x48 param | 0x49 liga/desliga | 0x44 ordem | 0x47 modelo | 0x43 troca
  // de preset ...] (formato do editor rvalladares). Parametro, liga/desliga e ordem
  // sao aplicados na hora (onEdit); o resto (troca de preset, modelo, mensagens
  // desconhecidas) faz reler o preset ativo inteiro (onChange({slot, bytes})).
  // onMessage(ev) recebe toda mensagem espontanea (log).
  const FOLLOW_DEBOUNCE_MS = 350;
  let follow = null, followTimer = null, followBusy = false, followAgain = false;
  function onPedalChange(onChange, onMessage = () => {}, onEdit = () => {}) {
    follow = { onChange, onMessage, onEdit };
    Dev.onUnsolicited = (ev) => {
      if (!follow) return;
      follow.onMessage(ev);
      if (ev.ownEcho) return;
      const p = ev.payload;
      if (p && p[0] === 0x12) {
        const edit = pedalEdit(p);
        if (edit) return follow.onEdit(edit);
      } else if (ev.program === undefined) return; // respostas/confirmacoes (0x14 ...), ruido
      clearTimeout(followTimer);
      followTimer = setTimeout(readPedal, FOLLOW_DEBOUNCE_MS);
    };
  }
  const u32At = (p, i) => (p[i] | (p[i + 1] << 8) | (p[i + 2] << 16) | (p[i + 3] << 24)) >>> 0;
  function pedalEdit(p) {
    const k = u32At(p, 2);
    if (p[1] === 0x48 && p.length >= 14 && k < 10) {
      const alg = u32At(p, 6), value = new DataView(Uint8Array.from(p.slice(10, 14)).buffer).getFloat32(0, true);
      if (alg >= Preset.PARAMS_PER_BLOCK) return null;
      if (shown) shown = Preset.writeBlock(shown, k, { values: { [alg]: value } });
      return { type: "param", k, alg, value };
    }
    if (p[1] === 0x49 && p.length >= 10 && k < 10) {
      const active = !!u32At(p, 6);
      if (shown) shown = Preset.writeBlock(shown, k, { active });
      return { type: "toggle", k, active };
    }
    if (p[1] === 0x44 && p.length >= 12) {
      const order = Array.from(p.slice(2, 12));
      if (!PRST.isPermutation(order)) return null;
      if (shown) shown = PRST.applyEdits(shown, { order });
      return { type: "order", order };
    }
    return null;
  }
  function stopFollow() { clearTimeout(followTimer); followAgain = false; }
  async function readPedal() {
    if (followBusy) { followAgain = true; return; }
    followBusy = true;
    try {
      if (paramLoop) await paramLoop;
      const r = await Dev.readActive();
      if (r.slot != null) activeSlot = r.slot;
      if (shown) shown = r.bytes; // a memoria de trabalho agora e esta
      if (follow) follow.onChange(r);
    } catch (e) { console.warn("[pedaleira] não consegui reler o preset ativo", e); }
    followBusy = false;
    if (followAgain) { followAgain = false; readPedal(); }
  }
  const onDisconnect = (cb) => { Dev.onDisconnect = () => { shown = null; stopFollow(); cb(); }; };

  root.Device = {
    connect, disconnect: () => { liveStop(); stopFollow(); Dev.disconnect(); }, readNames, readBanks, readSlots, writeSlot, verify,
    liveStart, liveAdopt, liveStop, liveSync, liveParam, save, saveName, onPedalChange, onDisconnect,
    isLive: () => !!shown, activeSlot: () => activeSlot, baseline: () => baseline, device: () => Dev.device(), isConnected: () => Dev.isConnected(),
  };
})(typeof self !== "undefined" ? self : this);
