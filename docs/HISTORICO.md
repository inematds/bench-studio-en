# Histórico: do kit original ao 1.3.2

O que foi construído em cima do Bench Studio original, e todos os defeitos
encontrados no caminho — **separando os que já existiam dos que eu introduzi**.

Base: 43 commits, de 2026-08-13 a 2026-08-17.

> **Sobre os hashes:** este repositório começa com um commit único, então os
> hashes citados abaixo são do repositório de desenvolvimento e não resolvem
> aqui. Eles ficam porque identificam cada mudança de forma única no relato — o
> valor do documento está no que aconteceu e por quê, não em clicar no link.

---

## Parte 1 — O ponto de partida

O kit original (`62ae1d5`, `574aa0e`) entregava:

- 37 rotas de imagem e vídeo, **todas no fal.ai**
- refino de prompt por perfil de modelo
- ledger de custo em dólar
- espelhamento local dos arquivos
- servidor MCP para conectar Claude, Codex e Cursor
- construtor de sites e documentos via Codex

Era um sistema de **um provedor**. Não existia o conceito de "provider": o
código falava fal diretamente, em todos os pontos.

---

## Parte 2 — O que foi implementado

### Multi-provider: de 37 para 73 modelos

| Commit | O quê |
|---|---|
| `8f95c30` | **Camada PROVIDERS** — um contrato (submit/poll/quote/actual), N backends. Modelo sem `provider` = fal, então as 37 rotas não mudaram no dia zero. |
| `9177c2d` | **Agnes** (4 modelos, custo zero) — primeiro provedor não-fal |
| `43c31af` | **inemaimg** (2 modelos, local na GPU) |
| `85aeb23` | **kie.ai** (4 modelos, créditos) |
| `1120d1a`, `7ac3f10` | **Kling** (26 modelos) via CLI oficial com OAuth; catálogo gerado sozinho do `who_am_i` |

### Catálogo e curadoria

| Commit | O quê |
|---|---|
| `91240ab` | Disponibilidade real por provedor (fato) separada de curadoria (preferência) |
| `2cf724c` | Filtros, ação em lote sobre o recorte, atualização sob demanda com frequência ajustável |
| `5c479fb` | Free e Local viraram interruptores de verdade; entra "Clear all" |
| `6df3037` | Provedor virou chip com filtro e interruptor próprio; rota visível no Create |
| `cabe485` | Classe de custo derivada do adapter (free/credits/paid/unknown) |
| `d046777` | Curadoria passa a valer também no seletor do Create e no MCP |

### Resultados e fluxo de trabalho

| Commit | O quê |
|---|---|
| `87e6747` | **Redo** — refazer um resultado com a configuração exata |
| `f30185e` | Filtros de resultados por tipo, provedor e modelo |
| `d4209b2` | **Aba Modes** — criar modos e submodos sem tocar em código |

### Construtor de sites e documentos

| Commit | O quê |
|---|---|
| `09ae4fe` | Motor escolhível: codex, claude code, qwen local, openrouter |
| `d7ebd9a` | Editar e apagar arquivos da build; detectar arquivo referenciado e ausente |
| `8f6cfc9` | Build falhada mostra o motivo real e os arquivos que sobraram |
| `c0378f4` | Rodada de conserto quando o modelo esquece um arquivo |
| `7b66049` | Referência de acabamento configurável pela tela + resumo de design |

### Configuração e segurança (esta sessão)

| Commit | O quê |
|---|---|
| `1b444d6` | `.env.example` com as 16 variáveis reais (documentava 5) |
| `8814c7d` | **Tela de Config** + trava de loopback + error boundary por workspace |
| `0738f85` | **Senha opcional** (scrypt, cookie httpOnly) + correção da trava |

### Infraestrutura

| Commit | O quê |
|---|---|
| `459df15` | `BENCH_WEB_HOST` — publicar a interface na rede local |
| `b263aa5` | Versão no topo, lida do `package.json`; interface toda em inglês |
| `e61b7c4` | Cadeia de refino com três elos |

---

## Parte 3 — Bugs DO SISTEMA ORIGINAL

Defeitos que já estavam no código do kit, ou em premissas que ele assumia.
Nenhum destes foi introduzido por mim.

### 3.1 — Chrome do macOS fixo no código

`09ae4fe` · **Gerar PDF nunca funcionaria em Linux.** O caminho do Chrome estava
escrito fixo, no formato do macOS. Corrigido: procura os nomes usuais e aceita
`BENCH_CHROME`.

### 3.2 — `stderrReason` pegava a linha errada do stack trace

`09ae4fe` · A mensagem de um stack trace está na **primeira** linha; o código
pegava a última, entregando `at async file:///...project_runner.mjs:87:1` como
"motivo do erro".

Complemento em `8f6cfc9`: numa falha real do usuário, a tela mostrou
`Node.js v24.13.0` — o rodapé do stack. O motivo passou a sair do
`codex-events.jsonl`, onde a última fala do agente explica a causa muito melhor.
A falha real passou a dizer: *"o sandbox do workspace falhou ao iniciar (bwrap:
Failed RTM_NEWADDR: Operation not permitted)"*.

### 3.3 — O padrão de erro não casava com `Error:` puro

`7b66049` · O padrão exigia prefixo antes de `Error`, casando com `TypeError` e
falhando justamente no `Error:` puro — que é o que `throw new Error` produz. A
tela mostrava um quadro do stack no lugar do motivo escrito à mão.

### 3.4 — `publicProviderError` escondia os bugs

`85aeb23` · Trocava **toda** mensagem de erro por "tente de novo". Isso não
protegia ninguém: escondia defeitos reais (os do item 3.5) de quem podia
consertá-los. Agora repassa a mensagem do adapter, redigindo a chave.

### 3.5 — Data URI de referência inchava o recibo e vazava como texto na tela

`39380ec` · Uma referência enviada como data URI chega com o arquivo **inteiro**
em base64 — 2 MB para uma imagem comum. Dois estragos:

1. **Na tela:** o painel listava os params como texto, então 2 MB de base64 eram
   despejados na tela.
2. **No peso:** os bytes iam para o banco, e o `/api/ledger` passou a trafegar
   8 MB a cada abertura — por causa de **duas linhas**.

Medido depois da correção: 8210 kB → 98 kB; maior linha 2 MB → 3 kB.

### 3.6 — `.env.example` documentava 5 variáveis; o código lia 16

`1b444d6` · Quem clonasse descobria o resto no erro.

### 3.7 — O `.env` do projeto nunca era lido

`8814c7d` · O servidor só carregava `~/.env`, embora o `.env.example` sempre
tenha documentado a precedência com o arquivo do projeto no meio. **Copiar o
exemplo para `.env` não fazia efeito nenhum.**

### 3.8 — `BENCH_DATA_DIR` vindo de arquivo era ignorado em silêncio

`8814c7d` · O carregamento do ambiente rodava **depois** de `DATA` já ter sido
resolvido. A variável era lida quando já não servia para nada.

### 3.9 — Sem `FAL_KEY`, o estúdio não subia

`8814c7d` · Morria no boot com `exit(1)`, contradizendo a regra de todos os
outros provedores — cada um aparece indisponível com o motivo. Quem usasse só
Agnes ou modelos locais não conseguia nem abrir a interface para descobrir o que
faltava. Isso também inviabilizava VPS e distribuição.

### 3.10 — Grid do catálogo esticava os cards ao filtrar

`b263aa5` · `repeat(auto-fit, ...)` colapsa as trilhas vazias e estica os cards
restantes pela largura toda: com 4 modelos filtrados, cada card virava uma faixa.
`auto-fill` mantém as trilhas.

### 3.11 — A lista do seletor era invisível

`b263aa5` · O `select` tinha fundo `rgba(255,255,255,.03)`, e a lista suspensa
**nativa** herda essa cor — texto claro sobre fundo claro. A lista existia e não
dava para ler.

### 3.12 — Contraste reprovado no WCAG AA

`8814c7d` · Interruptores ligados eram branco sobre o roxo do accent: 3,05:1,
contra os 4,5:1 exigidos. Sempre foram — só não apareciam porque a aba Models
estava quebrada (ver 4.1).

### 3.13 — Nenhum error boundary na árvore

`8814c7d` · Qualquer exceção em qualquer aba desmontava o app inteiro. Não era um
bug ativo, era a **ausência de contenção** que transformou o bug 4.1 numa tela
preta total em vez de um cartão de erro.

### 3.14 — A suíte e2e nunca tinha rodado nesta máquina

`1bd64c6` · O Chromium do Playwright não estava instalado. Havia um teste
chamado *"primary navigation exposes every workspace without console errors"* que
cobria exatamente o bug 4.1 — e nunca teve como executar.

### 3.15 — Curadoria não valia onde o modelo é escolhido

`d046777` · Buraco encontrado pelo usuário: desligar modelos mudava só a
aparência do catálogo. O seletor do Create e o `list_models` do MCP seguiam
oferecendo os 73. "Desliguei 60 modelos" não mudava nada no lugar onde o modelo é
de fato escolhido.

### 3.16 — Clicar num card levava embora em vez de ligar

`ac35c47` · Ligar/desligar só existia dentro de um "modo curadoria" escondido.
Fora dele, clicar num card ia para o Create — quem clicava querendo **ativar** um
modelo era levado embora, e o modelo continuava desligado. Modelo desligado
também sumia da lista, então não havia como ligá-lo de volta.

---

## Parte 4 — Bugs QUE EU INTRODUZI

Defeitos criados por mim durante esta implementação. Estão aqui com a mesma
prioridade dos outros, porque um histórico que só conta os erros dos outros não
serve para nada.

### 4.1 — `creditIds` nunca declarado: a aba Models apagava o app inteiro

Introduzido em `cabe485`, corrigido em `1bd64c6`.

O commit acrescentou o botão "Plan credits" usando `creditIds` e **não declarou a
variável**. `ReferenceError` no render, React desmonta a árvore, e a página fica
**preta** — não só o catálogo, o app todo.

Foi o usuário quem reportou. A API estava intacta o tempo todo (`/api/models`:
200, 73 modelos, 11ms). O mesmo commit deixou pela metade o que prometia: a lista
fixa `["agnes","inemaimg"]` continuou na interface enquanto o servidor já
derivava a classe do adapter.

**Por que passou:** o teste que cobria isso existia e nunca rodou (3.14).

### 4.2 — A trava de rede não travava ninguém

Introduzido em `8814c7d`, corrigido em `0738f85`.

Entreguei a trava de loopback testando contra a API direto (porta 8787), onde ela
funcionava. Mas o navegador **não fala com a API direto**: fala com o Vite, que
repassa. Quem abre o socket é o proxy, na mesma máquina — então todo mundo
parecia local. Medido com o estúdio em `--lan`:

```
http://192.168.1.172:5200/api/config → writable = true    ← a porta que se usa
http://192.168.1.172:8787/api/config → writable = false   ← a porta que testei
```

**A lição:** testei a porta que provava meu ponto, não a porta que as pessoas
usam.

### 4.3 — Referência local quebrava a geração remota

Introduzido junto com o Redo (`87e6747`), corrigido em `2db8ba4`.

O Redo recarregava a referência preferindo `local_url` (`/media/...`), que é
caminho **relativo** — só este servidor sabe resolver. Mandado a um provedor
remoto, ele respondeu o óbvio: *"image must be a public http(s) URL or valid
base64 image data"*.

Não dava para resolver com um formato único, porque cada provedor aceita uma
coisa (medido): Agnes aceita base64 (a doc afirma exigir URL pública, e é falso);
Kling recebe caminho local e faz o upload sozinho; kie e fal só URL pública;
inemaimg base64 cru. O adapter passou a **declarar** o que aceita.

### 4.4 — Miniatura quebrada ao restaurar referência no Redo

Introduzido em `87e6747`, corrigido em `59907a7`.

A barra desenha a miniatura a partir de `preview`, que no upload é um object URL
criado do `File` — memória do navegador, nunca persistida. A referência
restaurada aparecia quebrada mesmo estando **íntegra no disco** (a URL gravada
responde 200).

### 4.5 — Redo não subia para o painel de criação

Introduzido em `87e6747`, corrigido em `24418c4`.

Dois motivos: quem rola nesta aplicação é o container `.scroll`, não a janela
(então `window.scrollTo` não movia nada), e o salto precisava acontecer **depois**
do React trocar de aba. Com o arquivo cheio, a rolagem suave levava segundos —
durante os quais a tela parecia não ter reagido ao clique.

### 4.6 — Sufixo de rota indo para a API do provedor

Corrigido em `43c31af` (inemaimg) e `85aeb23` (Agnes).

`/edit` e `/i2v` existem no registry só para declarar a lane. Eu mandava o sufixo
para a API, que respondia `model_not_found`. Na Agnes o defeito ficou **invisível
por um tempo** porque só `t2i` e `t2v` tinham sido testados.

Agravante do mesmo commit: `model_not_found` vinha embrulhado em 503 e disparava
o retry de 503 — **quatro tentativas com backoff para um erro que nunca
melhoraria**.

### 4.7 — Pedir arquivos em JSON ao motor de modelo

Corrigido dentro de `09ae4fe`.

Escolhi JSON como formato de saída do construtor. O Qwen devolveu 18 mil
caracteres e o parse morreu na posição 5731. Não é falha do modelo: escapar
milhares de caracteres de HTML dentro de string JSON, sem errar uma vez, é frágil
por construção. Trocado por delimitador de linha, onde nada precisa ser escapado.

### 4.8 — Injetar a referência crua diluía o prompt

Corrigido em `7b66049`.

Injetei 20 mil caracteres de HTML da referência no prompt. Resultado medido:
~99% do prompt era marcação (5.000 tokens contra 60 do brief) e a saída **ignorou
a referência por completo** — a referência era escura, a saída veio clara e
serifada. Trocado por um resumo de design de algumas centenas de tokens.

### 4.9 — "Grátis" como suposição codificada

Corrigido em `cabe485`, apontado pelo usuário.

Escrevi na interface que Agnes e inemaimg **são** gratuitos. Não são: grátis não
é propriedade de um provedor, é o que a conta cobra hoje. O free tier do Gemini
esgotou no meio da própria sessão em que escrevi isso.

### 4.10 — Rótulos com duas ações e um nome só

Corrigido em `5c479fb`.

"Free only" e "Local only" faziam **duas** coisas anunciando uma: ligavam aquele
grupo e desligavam todo o resto. A segunda ação ficava escondida atrás de um
rótulo que não a anunciava.

### 4.11 — Input controlado que apagava o espaço

Corrigido em `d4209b2`.

Dividia e dava trim a **cada tecla**: o espaço era apagado no instante em que era
digitado, e "selfie de mão" virava "selfiedemao".

### 4.12 — Comentário JSX quebrando o build

Corrigido em `e61b5a3`.

Um `{/* */}` dentro de `{cond && ( ... )}` vira um segundo filho da expressão, o
que não compila. Eu tinha commitado sem olhar a saída do build.

### 4.13 — `mergeEnvText` punha linha em branco no topo

Corrigido antes do commit, pego pelo teste que eu tinha acabado de escrever.
Arquivo vazio (`""`) virava `[""]` no split, e a primeira linha do `.env` saía em
branco.

---

## Parte 5 — Padrões que se repetiram

Ler os 37 commits de uma vez faz alguns padrões saltarem:

**A documentação do provedor mente.** A doc da Agnes afirma exigir URL pública
para referência — aceita base64. A doc antiga falava em modos `t2v`/`ti2vid` que
devolvem 400. O `getTask` do kie está aposentado. Em todos os casos, quem decidiu
foi o teste contra a API viva.

**Testar só o caminho feliz esconde metade.** `/edit` e `/i2v` quebrados por
meses porque só `t2i` e `t2v` tinham sido exercitados. A trava de rede testada na
porta errada. O teste e2e que existia e nunca rodou.

**Erro engolido é pior que erro cru.** `publicProviderError` trocando tudo por
"tente de novo" escondeu dois bugs reais. Pegar a linha errada do stack trace
entregou `Node.js v24.13.0` como diagnóstico.

**Um único elo é um ponto único de falha.** O free tier do Gemini esgotou e
derrubou o refino de todos os modelos, o que fez a Agnes recusar por português.
O sintoma apareceu longe da causa.

**Falhar em silêncio é o pior jeito de falhar.** A build que passou por
"completa" sem o `app.js` entregou uma página com o conteúdo invisível. Parecia
fonte que não carregou; era conteúdo que nunca apareceria.

**O que não é medido é inventado.** Custo em crédito não vira dólar. Preço que
não veio não é "atualizado". Modelo cobrado por segundo de compute é `unknown`,
não um chute.
