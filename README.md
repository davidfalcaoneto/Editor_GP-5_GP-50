# Editor GP-5 / GP-50

Feito por **David Falcão Neto** · [Instagram](https://www.instagram.com/davidfalcaoneto/) · [LinkedIn](https://www.linkedin.com/in/davidfalcaoneto/) · [GitHub](https://github.com/davidfalcaoneto) · [☕ Buy me a coffee](https://buymeacoffee.com/davidfalcaoneto)

Projeto independente, não oficial: sem vínculo com a Valeton.

Editor de presets para as pedaleiras Valeton GP-5 e GP-50, com edição em massa.
Roda no navegador (Chrome ou Edge) e conversa com a pedaleira pelo USB (Web MIDI) ou pelo Bluetooth (Web Bluetooth).

## Como abrir

**Online:** https://davidfalcaoneto.github.io/Editor_GP-5_GP-50/ — abra no Chrome ou no Edge (computador ou Android) e clique em USB ou Bluetooth. Não precisa instalar nada.

**No seu computador:**

Clique duas vezes em **Abrir Editor.bat** (ou, no VS Code, aperte F5). Deixe a janela preta aberta enquanto usa o editor.

Pelo terminal: `python iniciar.py` (no Mac: `python3 iniciar.py`). Abre `http://localhost:8050` no Chrome. Web MIDI não funciona abrindo o `index.html` direto (file://).

## Como usar

Layout inspirado no editor [rvalladares.com/gp5/gpeditor](https://rvalladares.com/gp5/gpeditor/). Três telas:

- **Editor** — um preset por vez. Conecte por **USB** ou **Bluetooth** no topo; o preset ativo da pedaleira abre sozinho e fica **ao vivo**: tudo que você muda soa na hora (fica na memória de trabalho até salvar).
  - Seletor ‹ › no topo troca de preset na pedaleira (teclas PgUp/PgDn).
  - **Cadeia de sinal:** clique num bloco para editar; duplo clique liga/desliga (teclas 1…0); arraste NR, PRE, MOD, DLY e RVB para mudar a ordem (o núcleo DST·N→S·AMP·CAB·EQ é fixo, como na pedaleira). Com o N→S ligado, AMP e CAB aparecem riscados (a pedaleira os ignora).
  - **Bloco:** modelo, liga/desliga e parâmetros. O Time do delay pode ser em ms ou sincronizado com o BPM (1/4, 1/8 pont. …).
  - **Tempo:** TAP (barra de espaço), BPM. Com o delay sincronizado (ou na GP-50) muda o BPM do preset; com o delay em ms (GP-5), ajusta o Time do delay em 1/4, 1/8 ou 1/8 pontuada.
  - **Nível:** volume do preset e o slot dele.
  - **CTL:** quais blocos cada CTL liga/desliga (GP-5: um CTL; GP-50: CTL 1 e CTL 2). Os blocos no CTL aparecem marcados na cadeia.
  - **Salvar na pedaleira** grava no slot ativo, com nome de até 10 caracteres, e confere relendo o slot. Um arquivo aberto vai para a pedaleira com "Tocar no slot NN" e depois Salvar.
  - A barra de baixo (só no Editor) age no preset aberto: **Salvar na pedaleira**, **Salvar em arquivo** (formato original, GP-5 ou GP-50), Desfazer (Ctrl/Cmd+Z) e Descartar alterações.
- **Biblioteca** — uma linha de ações em grupos: **Abrir** (arquivos `.prst`, pasta inteira, ou arrastar), **Ler da pedaleira** (vários slots) e **Com os selecionados**: Salvar em arquivos (convertendo GP-5 ↔ GP-50) e Salvar na pedaleira (cada um no slot dele, com backup e conferência). Os botões têm o mesmo nome dos do Editor; a diferença é o alvo: no Editor, o preset aberto; na Biblioteca, os selecionados. **Edição em massa** nos selecionados, sempre com prévia:
  - renomear (modelo com `{nome}`, `{slot}`, `{n}`, localizar/substituir, maiúsculas/minúsculas);
  - copiar um bloco do preset aberto no Editor para todos, opcionalmente só onde o bloco usa certo modelo;
  - ajustar um parâmetro (definir ou somar) em todos que usam um modelo;
  - ligar/desligar um bloco;
  - CTL: definir, adicionar ou tirar blocos do CTL 1 ou 2 (a coluna CTL da tabela mostra o que cada preset usa).
- **Pedaleira** — backups da sessão, User IRs e SnapTones (e quais presets usam cada um), nomes dos 100 slots e o log das mensagens que a pedaleira manda.

**Acompanhar a pedaleira** (opção no topo): trocar de preset, mexer em knob, ligar/desligar bloco ou mudar a ordem na própria pedaleira aparece no editor na hora. Se o preset tem alterações suas não salvas, elas são mantidas.

No Bluetooth, desconecte antes o app do celular. No Mac, o Chrome precisa de permissão em Ajustes do Sistema → Privacidade e Segurança → Bluetooth. Tema claro, escuro ou automático no botão ◐.

## Estrutura

| Pasta | Conteúdo |
|---|---|
| `app/` | o editor (HTML/CSS/JS sem build) |
| `app/js/` | `preset.js` (blocos do .prst), `bulk.js` (edição em massa), `device.js` (pedaleira: ao vivo, salvar, gravar), `main.js` (interface) |
| `app/lib/` | formato .prst e protocolo (USB e Bluetooth); parte do código vem do trabalho de [drewmerc302/valeton-gp50](https://github.com/drewmerc302/valeton-gp50) (MIT) |
| `app/data/` | catálogo de efeitos da GP-5 e da GP-50 (mesma origem) |
| `conversor/` | conversor GP-50 → GP-5 em Python (linha de comando) |
| `tests/` | `node tests/test_bulk.mjs` — testa com os presets de fábrica, que ficam fora do repositório em `../gp5/Presets` e `../gp50/Presets`; `node tests/test_ble.mjs` — pacotes Bluetooth; `node tests/test_device.mjs` — ao vivo, salvar e gravar contra a pedaleira simulada (`tests/fake_pedal.js`) |

## Protocolo — o que já foi confirmado na GP-5 (USB, 29/10/2026)

- Leitura dos 100 nomes (SysEx seletor `0x40`) e do preset ativo (`0x41`): ok, byte a byte igual aos arquivos. Na lista de nomes, o slot é a **posição** do registro (20 bytes cada); o número que vem dentro do registro pode estar trocado (numa GP-50 vieram 14↔15) e não é usado.
- **A GP-5 ignora Program Change pelo USB.** Trocar de preset funciona com a SysEx `[0x11, 0x43, slot]` ou com CC#0 = slot. O editor usa a SysEx nas duas pedaleiras (`app/lib/webmidi_device.js`); na GP-50 ela também funciona pelo USB (testado em 09/11/2026).
- Leitura dos nomes de SnapTones (`0x24`: 80 registros, 0–49 de fábrica, 50–79 do usuário) e User IRs (`0x20`: 20 registros): ok.
- Edição ao vivo (memória de trabalho, nada é gravado): modelo `[0x11,0x47, bloco u32, bloco u32, fxid u32]` (parâmetros voltam ao padrão), parâmetro `[0x11,0x48, bloco u32, algId u32, float32]`, liga/desliga `[0x11,0x49, bloco u32, 0|1 u32]`. Trocar de preset descarta as edições. Na GP-50 esses comandos, ordem, volume e BPM funcionam igual (testado por USB em 09/11/2026).
- Slot ativo: pedido `[0x12, 0x43]`, resposta `[0x12, 0x43, slot, …]`.
- **Bluetooth:** a pedaleira usa o serviço BLE-MIDI padrão (`03b80e5a-…`, característica `7772e5db-…`) com as **mesmas** SysEx do USB, em pacotes `80 80 F0 … F7` (formato do gp5-wc, que funciona na GP-5). As mensagens espontâneas da pedaleira chegam como `[0x12, comando, …]` (ex.: `[0x12, 0x43, slot]` ao trocar de preset). O transporte está em `app/lib/webmidi_device.js` (`connectBle`).
- Comandos da memória de trabalho usados pelo editor rvalladares (que funciona na GP-5 por Bluetooth e USB): CTL `[0x11,0x4D, ctl, bloco, 0|1]` (GP-5), ordem `[0x11,0x44, 10 bytes]`, volume `[0x11,0x42, 01 20 00 00, vol u32]`, BPM `[0x11,0x42, 02 20 04 00, bpm u32]` e **salvar** `[0x11,0x4A, slot u32, nome 10 bytes]`. A pedaleira avisa o que se mexe nela com `[0x12, comando, …]` espelhando esses comandos (`0x48` parâmetro, `0x49` liga/desliga, `0x44` ordem, `0x47` modelo, `0x43` troca de preset; pelo USB a troca vem como `[0x12, 0x1B]`, sem o número).
- **CTL na GP-50 é diferente:** `[0x11,0x4D, CTL1 u32, CTL2 u32]` — as duas máscaras inteiras (bits 0–9 = blocos na ordem NR, PRE, DST, AMP, CAB, EQ, MOD, DLY, RVB, N→S). Mandar o formato da GP-5 faz a GP-50 copiar os bytes do comando para as máscaras e estraga o CTL do preset (era a causa dos erros ao configurar CTL e ao salvar). Os bits acima do 9 variam de preset para preset e a pedaleira os mantém; o editor os preserva. Os 2 bytes depois das máscaras (`05`/`06`) são o estado de cada botão (invertem a cada pisada), não configuração. Tap tempo (segurar A) só muda o BPM, e o modo de passagem de presets (segurar B) não fica no preset. A GP-50 não avisa quando o CTL é mudado na própria pedaleira (testado em 09/11/2026).
- O salvar `0x4A` grava a memória de trabalho no slot pedido (nome e efeitos) e a pedaleira passa para esse slot. Por isso o editor confere o slot ativo (`[0x12, 0x43]`) ao abrir um slot e antes de salvar: se a pedaleira estiver noutro, não grava.
- Gravação: na **GP-5** o editor carrega o preset na memória de trabalho e usa o salvar nativo `0x4A` (a importação `0x1D` do Valeton Suite falhou na GP-5 no slot 31). Na **GP-50**, gravar em lote usa `0x1D` (confirmado em capturas); Salvar no Editor usa `0x4A` nas duas.
- Nos presets de fábrica da GP-5 o Time do delay às vezes vale 1…10 (abaixo do mínimo de 20 ms): é a figura sincronizada com o BPM do preset (0 = 1/1 … 10 = 1/16). Ou seja, a GP-5 também guarda BPM por preset.

## Pendências conhecidas

- **Pedal de expressão (GP-50):** a configuração fica nos registros 3 a 10 do bloco de ajustes do preset, mas todos os presets de fábrica têm os mesmos valores (3=0 4=0 5=100 6=0 7=0 8=100 9=0 10=0), então não dá para saber o que cada um significa. Para decodificar: exportar do Valeton Suite (ou da GP-50) o mesmo preset duas ou três vezes, mudando só uma coisa do EXP de cada vez (destino, mínimo, máximo), e comparar.

- **Falta confirmar no aparelho:** salvar `0x4A` e o caminho de gravação da GP-5 (vêm do editor rvalladares, que funciona, mas este editor ainda não rodou na pedaleira); o comando de BPM na GP-5; tudo na GP-50 pelo Bluetooth. Testado contra a pedaleira simulada (`tests/fake_pedal.js`), que imita o que se sabe do aparelho.
- **Acompanhar a pedaleira pelo USB:** pelo USB a pedaleira avisa a troca de preset (`[0x12, 0x1B]`, segundo o editor rvalladares); se ela manda também knobs pelo USB, o log da aba Pedaleira mostra.

- **Enviar IR (.wav) e NAM para a pedaleira:** o protocolo de envio não é público. A conversão NAM → SnapTone é feita por código proprietário do Valeton Suite. Para avançar é preciso capturar o tráfego USB do Suite enviando um IR e um NAM.

- Os presets acústicos da GP-50 (31 a 35) usam os gabinetes `0x0a00003c` ("AC", só existe na GP-50) e `0x0a00003d` (fora dos catálogos). O conversor de linha de comando não verifica isso.

## Licença

MIT — veja [LICENSE](LICENSE). Os arquivos de `app/lib/` e `app/data/` aproveitam o trabalho de [drewmerc302/valeton-gp50](https://github.com/drewmerc302/valeton-gp50), também MIT.

## Inspiração e agradecimentos

Este editor se inspirou no que a comunidade já produziu sobre as pedaleiras Valeton:

- [rvalladares.com/gp5/gpeditor](https://rvalladares.com/gp5/gpeditor/) — editor web da GP-5/GP-50: inspirou o layout e mostrou os comandos de edição ao vivo e de salvar no slot.
- [helvecioneto/gp5-wc](https://github.com/helvecioneto/gp5-wc) — controlador web da GP-5: inspirou a conexão por Bluetooth.
- [drewmerc302/valeton-gp50](https://github.com/drewmerc302/valeton-gp50) — estudo do formato .prst e do protocolo USB, cujo código (MIT) é usado em `app/lib/` e `app/data/`.

