# Bench Studio — como funciona por dentro

Documento de referência. O `README.md` é para instalar e usar; este é para
entender por que o sistema é assim, e onde mexer quando precisar mudá-lo.

Versão descrita: **1.3.2**. Medições feitas em 2026-08-17.

---

## 1. O que o sistema é

Um agregador local. Ele guarda as suas chaves, conhece o formato que cada modelo
espera, reescreve o seu pedido no estilo daquele modelo, envia, acompanha, baixa
o arquivo e anota o custo.

Nada disso é difícil — e esse é justamente o ponto. É a camada pela qual os
serviços de wrapper cobram assinatura.

**Não há nenhum LLM gerenciando o sistema.** Roteamento, catálogo, preço,
disponibilidade, curadoria, retry e polling são código determinístico. O modelo
é ferramenta contratada por tarefa, nunca gerente. É por isso que o custo é
previsível.

---

## 2. Anatomia: dois processos

| Processo | O quê | Porta | Entrega |
|---|---|---|---|
| **Vite** | servidor da interface | 5200 | HTML, CSS, JS — o molde vazio da tela |
| **Express** | a API | 8787 | modelos, resultados, mídia, ledger, configuração |

O navegador carrega a casca do Vite; a casca pergunta os dados à API. O Vite
repassa `/api`, `/media`, `/previews`, `/inputs` e `/projects` para a API, então
do ponto de vista do navegador tudo vem da 5200.

Essa separação tem consequência de segurança — veja §8.

---

## 3. A camada PROVIDERS

O núcleo não sabe o que é fal, Agnes ou Kling. Ele conhece **um contrato**, e
cada provedor o implementa:

```
submit(modelId, params)  → job
poll(job)                → { status, outputs }
quote(modelId, params)   → { value, unit }   // orçamento antes de rodar
actual(job)              → custo real medido
availability()           → { available, reason, hint }
accepts                  → que formato de referência o provedor aceita
```

O modelo declara o backend pelo campo `provider` no registry. Ausente = `fal`,
então as 37 rotas originais continuaram funcionando sem alteração no dia em que
a camada nasceu.

**Os cinco provedores (73 modelos):**

| Provedor | Modelos | Cobrança | Autenticação |
|---|---|---|---|
| fal.ai | 37 | dólar, preço ao vivo | `FAL_KEY` |
| Kling | 26 | créditos do plano | CLI oficial com OAuth |
| Agnes AI | 4 | zero | `AGNES_API_KEY` |
| kie.ai | 4 | créditos | `KIE_API_KEY` |
| inemaimg | 2 | zero (local, sua GPU) | nenhuma |

### Armadilhas medidas, por provedor

**Agnes** — não é local: é gateway em `apihub.agnes-ai.com`. Recusa português
com HTTP 400 no filtro de conteúdo, então o refino é obrigatório, não enfeite.
503 pede backoff; 429 pede recuo de 70s; o polling é espaçado em 15s porque a
própria consulta de status tem limite de taxa. 400/404 na consulta significa job
morto, não "esperando". Teto de 2 referências.

**kie.ai** — `createTask` + polling em `recordInfo` (o `getTask` de projetos
antigos está aposentado e devolve 404). Código 422 `recordInfo is null` nos
primeiros segundos é espera, não falha. **HTTP 200 com código interno diferente
de 200 é recusa** — tratar só o status HTTP deixaria a falha passar por sucesso.
Referência exige URL pública; data URI não serve.

**Kling** — não é HTTP com chave: é subprocesso autenticado por OAuth. O
catálogo se gera sozinho a partir de `kling who_am_i`, que publica parâmetros,
defaults e valores aceitos de cada modelo. **Sem retry automático, de propósito**
— a própria ferramenta avisa que todo job é cobrado e que não se deve
re-submeter. O CLI **trunca a saída em 65536 bytes** quando o stdout é pipe
(`who_am_i` tem 187 KB), então toda captura passa por arquivo temporário.

**inemaimg** — responde em base64, não em URL. O adapter grava o PNG e devolve
`local_path`; o espelhamento pula saídas que já são locais, senão o servidor
baixaria de si mesmo. Faz hot-swap de modelo em memória (~32 GB de VRAM), então
só um modelo fica registrado. Seed vazia é derivada do prompt, não constante —
com seed fixa, o retry devolveria a mesma imagem e seria ilusão de retry.

**fal** — o maior catálogo e o único com preço ao vivo por modelo, lido dos
schemas OpenAPI públicos.

### Modelos que existem em duas rotas

Seis famílias aparecem por mais de um caminho (Veo, Nano Banana, gpt-image,
gemini-image, Kling t2v/i2v). É de propósito: **a mesma família por rotas
diferentes tem contas e cobranças diferentes** — dólar ao vivo no fal contra
crédito do plano no Kling. O rótulo carrega "via Kling" e a API expõe `provider`
explicitamente, porque sem isso escolher a rota seria adivinhação.

---

## 4. Custo: três unidades que não se somam

O ledger registra `cost` em dólar. Crédito de plano **não é convertido** em
dólar, e não há taxa publicada — inventar um número corromperia o total gasto.

A classe de custo de cada modelo é **derivada do orçamento que o adapter
declara**, nunca de uma lista de nomes na interface:

| Classe | Significado | Medido hoje |
|---|---|---|
| `free` | custo zero agora | 6 (agnes 4, inemaimg 2) |
| `credits` | consome crédito de um plano | 26 (kling) |
| `paid` | cobra em dólar | 24 (fal 21, kie 3) |
| `unknown` | só dá para saber depois de rodar | 17 (fal 16 por segundo de compute, kie 1) |

"Grátis" não é propriedade de um provedor — é o que a conta cobra **hoje**. A
Agnes pode passar a cobrar; o free tier do Gemini esgotou no meio de uma sessão
de desenvolvimento. Se a cobrança mudar, muda no adapter e a tela acompanha.

**Consumo real** é medido, não estimado: no kie pelo delta de saldo em
`/chat/credit`, no Kling pelo delta de `kling account`, no fal pelo preço ao vivo.

---

## 5. Duas camadas no catálogo: disponibilidade e curadoria

A separação é o ponto. Misturadas, um modelo some sem que ninguém saiba se foi
falta de chave ou escolha — e aí não dá para agir.

**Disponibilidade** é fato, calculado, nunca gravado, com cache de 60s. Cada
adapter responde por si: fal/agnes/kie olham a chave, Kling olha a credencial do
CLI, inemaimg pergunta ao `/health` do servidor local. Modelo indisponível
aparece cinza com o motivo e como resolver — **não some**.

**Curadoria** é preferência, em `data/catalog-prefs.json`, e guarda **só as
exceções** (os ids desligados). Assim o padrão é "tudo que está disponível
aparece": quem clona abre um estúdio funcionando, e não um catálogo vazio que
parece quebrado. Modelo novo entra sozinho; apagar o arquivo volta ao estado de
fábrica.

Os dois estados têm tratamento **oposto** na geração:

- **sem chave** → `/api/generate` recusa dizendo o que falta, porque falharia de
  qualquer jeito, só que mais tarde e com erro do provedor;
- **desligado** → some das listas mas **ainda gera** se pedido pelo id. Bloquear
  quebraria o Redo de um resultado antigo cujo modelo foi desligado depois.
  Esconder é curadoria, não proibição.

A curadoria vale nos três lugares onde um modelo é escolhido: catálogo, seletor
do Create e MCP. Duas listas divergentes seriam duas verdades.

---

## 6. Refino de prompt: uma corrente, não um elo

`gemini-3-flash-preview` → `openrouter` → `codex local`

O refino traduz a ideia para inglês e a reescreve no estilo que **aquele** modelo
espera. Para a Agnes, ele é o que impede o HTTP 400.

Com um único reescritor, a cota dele derruba o estúdio inteiro — foi o que
aconteceu: o free tier do Gemini bateu o limite diário e todos os modelos
passaram a receber o prompt cru, em português. A resposta diz **quem assumiu**
(`rewriter`) e **de quem caiu** (`fallback_from`), senão parece que o perfil do
modelo parou de funcionar.

O Codex é o último recurso porque já está instalado e autenticado para os
workspaces de Website/Document: não custa chave nova nem dinheiro novo, e roda
sem rede e sem escrita em disco — é só texto.

**Perfis de refino** (64) ensinam o refinador o que cada família espera. O da
Agnes, por exemplo, carrega regras medidas: saída sempre em inglês, descritor de
estilo só com estética (`fur`, `expressive eyes` injetam personagem em cena
vazia), reafirmar o atributo do sujeito depois do estilo (o estilo sequestra:
"futurista" prateou um esquilo ruivo), e contagem **sempre na forma positiva**,
nomeando todas as partes duplicáveis de uma vez — `exactly one head` sozinho
voltou com duas caudas.

---

## 7. Construtor de sites e documentos: agentes contra modelos

O construtor não é "uma chamada de LLM": é algo que **produz arquivos**. Daí duas
famílias, e a diferença importa:

**Agentes** (`codex`, `claude`) escrevem os arquivos eles mesmos, iterando, e se
autocorrigem. O Codex depende do sandbox `bwrap`, bloqueado por AppArmor nesta
máquina (ver `apparmor-bwrap.md`); o Claude Code tem permissão própria e não
depende dele.

**Modelos** (`ollama` local, `openrouter`) só devolvem texto — quem grava é o
servidor. Nenhum sandbox entra na jogada, então funcionam em qualquer máquina.

**Pedir os arquivos em JSON falha.** Medido: o Qwen devolveu 18 mil caracteres e
o parse morreu na posição 5731. Não é falha do modelo — escapar milhares de
caracteres de HTML dentro de string JSON, sem errar uma vez, é frágil por
construção. O formato é delimitador de linha (`=== FILE: nome ===`), onde nada
precisa ser escapado.

**Verificação de integridade:** depois de gravar, o motor lê o HTML e confere se
todo arquivo local referenciado foi criado. Um modelo esqueceu o `app.js` em três
builds seguidas, sempre referenciando-o — a página abria com título e conteúdo
invisíveis, porque o CSS deixava elementos em `opacity: 0` esperando o JS.
Faltando arquivo, o motor faz **uma** rodada de conserto pedindo só o que falta,
com o HTML junto; se ainda faltar, falha dizendo o quê.

**Referência de acabamento:** um site ou PDF **seu** que o construtor pode
inspecionar para calibrar o nível de acabamento. Ele recebe um **resumo de
design** (tokens, fontes, paleta ordenada por frequência, raios, pesos), não o
HTML cru. Medido: injetar 20 mil caracteres de referência ocupou ~99% do prompt e
a saída **ignorou a referência por completo** — não foi falta de capacidade, foi
diluição.

---

## 8. Segurança

### O que protege o quê

| Camada | Protege | Como |
|---|---|---|
| Chaves no servidor | suas credenciais | nunca vão ao navegador; a tela de Config mostra presença, origem e 4 últimos caracteres |
| Trava de loopback | gravação de chave e senha | só de quem está na máquina, mesmo autenticado |
| Senha (opcional) | API e arquivos gerados | hash scrypt, cookie httpOnly, sessão de 12h |

### A trava de loopback e o proxy

Esta é a sutileza que quase passou. A trava olha o socket — mas o navegador
**não fala com a API direto**: fala com o Vite, que repassa. Quem abre o socket é
o proxy, na mesma máquina, então olhar só o socket faz **todo mundo parecer
local**. Medido com o estúdio em `--lan`:

```
http://192.168.1.172:5200/api/config → writable = true    ← a porta que se usa
http://192.168.1.172:8787/api/config → writable = false   ← a porta que ninguém usa
```

A correção tem duas metades: o Vite repassa a origem (`xfwd`), e a API só aceita
`X-Forwarded-For` **quando o socket já é loopback**. Essa condição é o que torna
o cabeçalho confiável — quem vem de fora não consegue abrir socket loopback, logo
não consegue forjar a origem. Aceitar o cabeçalho sem essa guarda seria pior do
que não ter trava nenhuma.

### A senha

`BENCH_PASSWORD` vazia = sem senha, e é assim que o estúdio vem. Falar com a
própria máquina não deveria pedir senha.

Definida, ela protege a API e os estáticos. Detalhes com o porquê:

- **Hash scrypt com sal.** Quem tem o `.env` pode *apagar* a senha (e o estúdio
  abre), mas não descobre qual era — o que importa se ela foi reusada em outro
  lugar.
- **Comparação em tempo constante.** `===` vaza, pelo tempo de resposta, quantos
  bytes iniciais bateram.
- **Cookie `httpOnly` + `SameSite=Lax`.** Um XSS não lê o cookie; outro site não
  usa a sua sessão por tabela. **Sem `Secure`**, de propósito: o estúdio roda em
  http na rede local, e um cookie `Secure` simplesmente não seria enviado.
- **Atraso progressivo, sem bloqueio permanente.** Travar a conta deixaria o dono
  do lado de fora da própria máquina.
- **Trocar a senha vale na hora e derruba as sessões abertas.** Esperar restart
  deixaria aberta justamente a janela em que o estúdio está exposto; manter
  sessões antigas faria "trocar a senha" não proteger de nada.

**O limite honesto:** a senha protege a API. A casca da interface continua sendo
servida a quem alcança a porta — sem sessão ela não mostra nada, mas a pessoa
descobre que existe um Bench Studio ali. Esconder também a casca é trabalho de
proxy reverso (Caddy, nginx), não deste processo.

**Recuperação:** apagar `BENCH_PASSWORD` do `.env` e reiniciar. Não há
recuperação por e-mail, e isso é uma propriedade: quem tem o arquivo já tem as
chaves que estão nele, então um mecanismo mais elaborado não protegeria de nada.

### Configuração: precedência

```
variável exportada no shell  >  .env do projeto  >  ~/.env
```

A tela de Config diz de onde cada valor veio, e avisa quando uma gravação seria
**sombreada** por um export do shell — sem esse aviso, a tela diria "salvo" e o
servidor continuaria usando o valor antigo.

---

## 9. Persistência e arquivos

SQLite (`node:sqlite`, sem dependência externa) em `data/bench.db`. Guarda
gerações, ativos, gasto e projetos.

**Toda mídia é espelhada localmente, de propósito** — as URLs dos provedores
expiram (24h no Kling, temporárias na Agnes). Isso é o que dimensiona o disco:
~1,3 MB por imagem, 0,7–5 MB por vídeo.

`data/` também guarda `catalog-prefs.json` (curadoria), `modes.json` (seus modos),
`settings.json` (referências e frequência de sync), `outputs/`, `previews/`,
`inputs/` e `projects/`.

Um recibo **nunca** carrega os bytes de um anexo: registra que houve anexo e
qual. Antes de tratar isso, uma referência em data URI colocava 2 MB de base64 no
banco e o `/api/ledger` trafegava 8 MB a cada abertura da tela. Medido depois da
correção: 8210 kB → 98 kB.

---

## 10. Uso de recursos

Medido com os 73 modelos carregados:

| Recurso | Uso |
|---|---|
| RAM | 274 MB (101 servidor + 173 Vite) |
| Disco app + node_modules | 482 MB |
| Disco de dados | 60 MB e crescendo |
| CPU | ocioso quase sempre — quem gera são as APIs remotas |

**O que dimensiona é disco, não CPU.**

---

## 11. Testes

```
npm run test:contracts   # 30 testes: banco, API, contratos, config, auth
npm run test:mcp         # o servidor MCP responde e expõe as ferramentas
npm run test:e2e         # navegador de verdade (Playwright)
```

O e2e exige `npx playwright install chromium` uma vez. Um teste depende de um
modelo específico estar ligado no catálogo, então pode falhar conforme a sua
curadoria — não é regressão.

---

## 12. Onde mexer

| Quero… | Arquivo |
|---|---|
| adicionar um provedor | `server/providers/` + registrar em `PROVIDERS` (server.mjs) |
| mudar o refino de uma família | `server/profiles/` |
| mudar o que a tela de Config conhece | `server/config_store.mjs` (`FIELDS`) |
| mexer na senha | `server/auth.mjs` |
| adicionar um motor de site/documento | `server/project_engines.mjs` (`ENGINES`) |
| mudar o catálogo do fal | `server/catalog_sync.mjs`, `server/build_registry.mjs` |
| mudar o catálogo do Kling | `node server/providers/kling_sync.mjs` |
