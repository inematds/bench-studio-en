# Acesso remoto e instalação em VPS

O que ficou decidido, por quê, e o que fazer na prática. Vale para VPS, para a
máquina do escritório vista de casa, e para qualquer caso em que o estúdio
precise ser alcançado de fora.

Versão de referência: **1.5.2**.

---

## 1. O resumo, se você só quer o comando

Numa máquina nova que vai ser alcançada de fora, nesta ordem:

```bash
git clone git@github.com:inematds/bench-studio-en.git
cd bench-studio-en
npm install
npm run set-password        # antes de abrir a porta, não depois
./scripts/remote.sh open    # publica a interface + regra de firewall
npm run dev
```

Ao terminar:

```bash
./scripts/remote.sh close
```

`./scripts/remote.sh status` responde a qualquer momento: aberto ou fechado, em
que porta, com ou sem senha, firewall ativo ou não.

---

## 2. Por que a senha vem antes da porta

Esta é a regra que organiza todo o resto:

> **A senha só pode ser definida na própria máquina.** Pela rede é 403 — mesmo
> com sessão válida, mesmo já logado com a senha certa.

`server.mjs:1827` recusa `POST /api/config/password` de qualquer origem que não
seja loopback. O mesmo vale para gravar chave de provedor.

Não é descuido, é a proteção principal do modo aberto. O estúdio sobe **sem
senha** de propósito. Se a gravação fosse liberada pela rede, o primeiro estranho
que achasse a porta aberta poderia **definir uma senha e trancar o dono para
fora** — sem recuperação por e-mail, sem nada a fazer além de voltar ao SSH.
Do jeito atual, quem tem a máquina sempre ganha.

A consequência prática é a assimetria: **depois que a porta abre, ninguém do
outro lado consegue mais fechar essa brecha**. Por isso o momento de pôr a senha
é a instalação, e por isso o `remote.sh open` pergunta antes de abrir.

### O que o `open` faz com isso

```
!  No password: whoever reaches the address gets in — that is the default.
   Set a password now? [Y/n]
```

- `Y` → chama o `npm run set-password` de verdade (pergunta duas vezes, não
  ecoa, não passa por argumento nem pelo histórico do shell).
- `n`, Enter, ou **nenhum terminal** (pipe, CI, cron) → abre sem senha e avisa em
  vermelho. Não bloqueia — decisão consciente.

### Como trocar a senha depois

Sempre na máquina:

```bash
npm run set-password              # define ou substitui; vale na hora, sem restart
npm run set-password -- --remove  # remove
```

Esqueceu? Apague a linha `BENCH_PASSWORD` do `.env` e reinicie. É o caminho de
recuperação, de propósito: quem tem o arquivo já tem as chaves dentro dele.

---

## 3. O que o `remote.sh` faz, exatamente

Três verbos, um arquivo de estado.

| Comando | O que faz |
|---|---|
| `./scripts/remote.sh open` | oferece a senha, publica a interface, abre a porta no ufw, grava o estado |
| `./scripts/remote.sh close` | lê o estado e desfaz exatamente aquilo |
| `./scripts/remote.sh status` | aberto/fechado, porta, senha, firewall |

Flags:

```bash
./scripts/remote.sh open --ip 203.0.113.7   # só esse endereço, não a internet
./scripts/remote.sh open --firewall         # também liga o ufw (SSH liberado antes)
```

O que ele toca, e nada além disso:

- `.env` → `BENCH_WEB_HOST=0.0.0.0` e `BENCH_API_HOST=127.0.0.1`, com `chmod 600`
- `ufw` → `allow OpenSSH`, depois `allow <porta>/tcp`
- `data/remote.state` → porta, valor anterior de `BENCH_WEB_HOST`, se a regra foi
  criada, restrição de IP e o horário

Decisões dentro do script:

- **O `close` lê o estado, não chuta.** Ele desfaz o que aquele `open` fez, não
  o que um `open` genérico costuma fazer.
- **A regra de SSH é liberada antes de qualquer `ufw enable` e nunca é
  removida.** Remover essa regra é como as pessoas se trancam para fora do
  próprio servidor.
- **Idempotente.** Rodar duas vezes não quebra.
- **Ele avisa se a porta continua escutando** depois do `close` — é o processo
  antigo, que precisa de restart.
- **Ele não liga o firewall sozinho.** Se o ufw estiver instalado e inativo, ele
  diz isso e oferece o `--firewall`, em vez de mudar a política da máquina por
  conta própria.

---

## 4. A API nunca é publicada

Mudança de comportamento na 1.4.2: `app.listen(PORT)` virou
`app.listen(PORT, BENCH_API_HOST)`, com padrão `127.0.0.1`.

Antes, a API escutava em todas as interfaces. Publicar a interface publicava
junto a porta 8787 — que é a que grava arquivo, chama provedor e gasta dinheiro —
sem ninguém ter pedido. Agora só a interface (5200) vai para fora; a API atende a
interface, que roda na mesma máquina.

O opt-out consciente existe: `BENCH_API_HOST=0.0.0.0`. Tenha um motivo.

---

## 5. A tela de Config vista da rede

Ela é a mesma tela para quem está na máquina e para quem chega de fora — só que
em modo leitura, porque o servidor recusa a gravação de qualquer jeito. O que
mudou na 1.5.2 foi parar de mentir sobre isso:

| Antes | Agora |
|---|---|
| dizia "has no authentication" **mesmo com senha definida** | duas mensagens: porta aberta sem senha (vermelho) e porta aberta com senha (informativa, lembrando que o tráfego é HTTP puro) |
| campo de senha desabilitado, sem dizer o que fazer | o comando que resolve (`npm run set-password`, na máquina) e o motivo da trava |
| campos de chave desabilitados | "defina na máquina" + link do provedor |
| mostrava o caminho absoluto do `.env` | escondido em modo leitura — ele denunciava, entre outras coisas, que o processo roda como root |
| botão `Test` ativo pela rede | só na máquina: testar dispara chamada ao provedor, é ação, não leitura |
| botões de salvar cinzentos | somem |

O que continua visível pela rede sem senha: quais provedores existem, se cada
chave está presente e seus 4 últimos caracteres. **Nunca o valor.**

---

## 6. Deixando no ar com segurança

Em ordem do que mais protege:

1. **Senha na instalação.** `npm run set-password` antes do `open`. Sem ela, a
   porta é a única barreira entre a internet e seus arquivos gerados.
2. **API em loopback.** É o padrão. `BENCH_API_HOST=0.0.0.0` é opt-out.
3. **Restringir quem alcança.** `remote.sh open --ip <seu-ip>` ganha de porta
   aberta. Tailscale ganha das duas, e não abre porta nenhuma.
4. **Firewall ligado.** `remote.sh open --firewall`. Confira **também** o painel
   de firewall do provedor da VPS: ele fica na frente do ufw e não obedece a
   ninguém dentro da máquina.
5. **HTTPS na frente.** Domínio apontado, nginx ou Caddy com Let's Encrypt
   servindo o `dist/` do `npm run build` e encaminhando `/api`, `/media`,
   `/previews`, `/inputs` e `/projects` para `127.0.0.1:8787`. Depois disso,
   feche a 5200 de vez.
6. **Usuário próprio, não root**, sob unidade systemd, com `.env` em `600` — que
   é como o estúdio já grava.
7. **Fechar quando o teste acabar.** `./scripts/remote.sh close`. A exposição
   esquecida é a que custa crédito de provedor.

### Atenção ao montar o nginx

A trava "só grava quem está na máquina" (`config_store.mjs:isLoopback`) aceita a
requisição quando o socket é loopback **e** o `X-Forwarded-For` também é local —
ou quando não há `X-Forwarded-For` nenhum.

Atrás de um proxy, quem abre o socket é o proxy, em 127.0.0.1. Se o nginx **não**
mandar `X-Forwarded-For`, todo mundo passa a parecer local e a gravação de chaves
fica aberta para a internet. O proxy do Vite manda (`xfwd: true` no
`vite.config.js`), por isso hoje funciona.

**Ao colocar nginx na frente, configure `proxy_set_header X-Forwarded-For`.**
Isto está registrado como pendência: o servidor deveria falhar fechado nesse
caso, em vez de depender da configuração do proxy estar certa.

---

## 7. Variáveis envolvidas

| Variável | Padrão | Para que serve |
|---|---|---|
| `BENCH_WEB_HOST` | `127.0.0.1` | em que interface a UI escuta. O `remote.sh` mexe nela; você não precisa |
| `BENCH_API_HOST` | `127.0.0.1` | em que interface a API escuta. Mudar isto é publicar a API |
| `BENCH_WEB_PORT` | `5200` | porta da interface |
| `PORT` / `BENCH_API_PORT` | `8787` | porta da API |
| `BENCH_PASSWORD` | vazio | hash scrypt da senha. Não edite na mão: use `npm run set-password` |

Ordem de leitura: exportado no shell > `.env` do projeto > `~/.env`.

---

## 8. O que ficou em aberto

Duas coisas conhecidas, nenhuma delas bloqueia o uso:

1. **`isLoopback` atrás de proxy reverso** — descrito na seção 6. Só morde com
   nginx/Caddy na frente. A correção seria falhar fechado (exigir o cabeçalho
   explícito quando o estúdio está exposto), em vez de confiar na configuração
   do proxy.
2. **O e2e depende de `FAL_KEY`.** Dois testes falham em máquina sem chave:
   `e2e.spec.mjs:71` procura no seletor um modelo da fal que não aparece sem
   chave, e `e2e.spec.mjs:195` compara um snapshot cuja barra de controles mostra
   outro modelo default. São 4 falhas contando desktop e mobile. Consequência:
   `npm run test:release` não passa para quem clona o repo sem chave. A correção
   de verdade é fixar um registry de teste, em vez de depender do que está
   disponível na máquina.

---

## Histórico das versões envolvidas

- **1.4.2** — `scripts/remote.sh` (`open`/`close`/`status`); API em loopback por
  padrão (`BENCH_API_HOST`); README com as seções de acesso remoto e
  endurecimento; correções de URL de clone, referência a um `dev.sh` inexistente
  e bloco duplicado.
- **1.5.2** — senha oferecida pelo `open`; tela de Config honesta em modo
  leitura; aviso de exposição deixa de mentir quando há senha.

Detalhe por versão no [CHANGELOG.md](../CHANGELOG.md).
