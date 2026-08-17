// auth.mjs — senha opcional para o estúdio.
//
// Sem `BENCH_PASSWORD` definida, NADA muda: o estúdio abre direto, como sempre
// abriu. A senha é uma tranca que você escolhe pôr, não um pedágio que o
// programa cobra. Esse é o comportamento de fábrica, de propósito — quem usa na
// própria máquina não deveria digitar senha para falar com o próprio computador.
//
// Com a senha definida, ela protege a API: modelos, resultados, mídia, ledger e
// configuração. A casca da interface continua sendo servida (é HTML público e
// igual para todos), mas sem sessão ela não recebe dado nenhum. Trancar também a
// casca é trabalho de proxy reverso, não deste processo.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const ESQUEMA = "scrypt";
const SESSION_COOKIE = "bench_session";
const SESSION_MS = 12 * 60 * 60 * 1000; // 12h

// Parâmetros do scrypt. N=2^15 leva ~100ms nesta classe de máquina: caro o
// suficiente para estragar a vida de quem tenta força bruta, barato o
// suficiente para um login não parecer travado.
const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 32;
// O scrypt precisa de 128*N*r bytes; com N=2^15 isso da 32 MB, exatamente o teto
// padrao do Node — que entao recusa. Declarar o dobro e o que faz esses
// parametros serem utilizaveis.
const MAXMEM = 64 * 1024 * 1024;

export function hashPassword(plain) {
  const senha = String(plain ?? "");
  if (senha.length < 4) throw new Error("Password must be at least 4 characters.");
  const salt = randomBytes(16);
  const chave = scryptSync(senha, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return [ESQUEMA, N, salt.toString("hex"), chave.toString("hex")].join("$");
}

/**
 * Comparação em tempo constante. Comparar hash com `===` vaza, pelo tempo de
 * resposta, quantos caracteres iniciais bateram — é o suficiente para descobrir
 * o valor byte a byte.
 */
export function verifyPassword(plain, stored) {
  const partes = String(stored ?? "").split("$");
  if (partes.length !== 4 || partes[0] !== ESQUEMA) return false;
  const [, n, saltHex, esperadoHex] = partes;
  try {
    const esperado = Buffer.from(esperadoHex, "hex");
    const obtido = scryptSync(String(plain ?? ""), Buffer.from(saltHex, "hex"), esperado.length, { N: Number(n), r: R, p: P, maxmem: MAXMEM });
    return obtido.length === esperado.length && timingSafeEqual(obtido, esperado);
  } catch {
    return false;
  }
}

/**
 * Sessões vivem em memória: reiniciar o servidor desloga todo mundo. É o
 * comportamento certo para um estúdio de uma pessoa — não vale a pena persistir
 * sessão, e um restart limpando o estado é uma propriedade, não um defeito.
 */
export function createAuth({ hash = process.env.BENCH_PASSWORD ?? "" } = {}) {
  let senhaHash = String(hash ?? "").trim();
  const sessoes = new Map();
  // Atraso progressivo por origem. Não bloqueia ninguém para sempre (o dono
  // erraria a senha e ficaria de fora da própria máquina); só torna a tentativa
  // automática lenta demais para valer a pena.
  const erros = new Map();

  const required = () => senhaHash !== "";

  function limpar() {
    const agora = Date.now();
    for (const [token, expira] of sessoes) if (expira <= agora) sessoes.delete(token);
  }

  function tokenDoPedido(req) {
    const cru = req?.headers?.cookie;
    if (!cru) return null;
    for (const parte of String(cru).split(";")) {
      const i = parte.indexOf("=");
      if (i === -1) continue;
      if (parte.slice(0, i).trim() === SESSION_COOKIE) return decodeURIComponent(parte.slice(i + 1).trim());
    }
    return null;
  }

  function authenticated(req) {
    if (!required()) return true;
    limpar();
    const token = tokenDoPedido(req);
    if (!token) return false;
    const expira = sessoes.get(token);
    return Boolean(expira && expira > Date.now());
  }

  function abrirSessao(res) {
    const token = randomBytes(32).toString("hex");
    sessoes.set(token, Date.now() + SESSION_MS);
    // httpOnly: um XSS não consegue ler o cookie e levar a sessão embora.
    // SameSite=Lax: outro site não consegue usar a sua sessão por tabela.
    // Sem `Secure`: o estúdio roda em http na sua rede, e um cookie Secure
    // simplesmente não seria enviado — a senha pararia de funcionar.
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}`);
    return token;
  }

  function fecharSessao(req, res) {
    const token = tokenDoPedido(req);
    if (token) sessoes.delete(token);
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  }

  function atrasoDe(chave) {
    const falhas = erros.get(chave) ?? 0;
    return Math.min(falhas * 250, 4000);
  }

  async function login(req, res, senha) {
    if (!required()) return { ok: true, required: false };
    const origem = req?.socket?.remoteAddress ?? "?";
    const espera = atrasoDe(origem);
    if (espera) await new Promise((r) => setTimeout(r, espera));

    if (!verifyPassword(senha, senhaHash)) {
      erros.set(origem, (erros.get(origem) ?? 0) + 1);
      return { ok: false, error: "Wrong password." };
    }
    erros.delete(origem);
    abrirSessao(res);
    return { ok: true, required: true };
  }

  // Trocar a senha em memória evita exigir restart para a tranca passar a valer
  // — que é o caso em que esperar pelo restart seria pior: a janela entre
  // "defini a senha" e "ela vale" é justamente quando o estúdio está exposto.
  // As sessões abertas caem junto: mudar a senha tem de expulsar quem entrou com
  // a antiga, senão trocar a senha não protege de nada.
  function setHash(novo) {
    senhaHash = String(novo ?? "").trim();
    sessoes.clear();
  }

  return { required, authenticated, login, logout: fecharSessao, setHash, SESSION_COOKIE };
}
