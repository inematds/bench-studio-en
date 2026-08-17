#!/usr/bin/env node
// npm run set-password — define, troca ou remove a senha do estúdio pelo terminal.
//
// Existe para o caso em que a tela não serve: numa VPS não há navegador em
// loopback, e a tela de Config só aceita gravação de quem está na máquina. Sem
// este comando, definir a PRIMEIRA senha viraria um problema de ovo e galinha.
//
//   npm run set-password            (pergunta a senha, sem ecoar)
//   npm run set-password -- --remove

import { createInterface } from "node:readline";
import { hashPassword } from "./auth.mjs";
import { writeConfig, PROJECT_ENV } from "./config_store.mjs";

// Senha digitada não pode aparecer no terminal nem ficar no histórico do shell —
// por isso ela é perguntada aqui, e não aceita como argumento.
function perguntar(pergunta) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const saida = process.stdout;
    let ligado = true;
    const escrever = saida.write.bind(saida);
    saida.write = (chunk, ...resto) => (ligado ? escrever(chunk, ...resto) : true);
    escrever(pergunta);
    ligado = false;
    rl.question("", (resposta) => {
      ligado = true;
      escrever("\n");
      saida.write = escrever;
      rl.close();
      resolve(resposta);
    });
  });
}

const remover = process.argv.includes("--remove");

if (remover) {
  writeConfig({ BENCH_PASSWORD: "" });
  console.log(`Password removed from ${PROJECT_ENV}. Restart the studio and it opens without one.`);
  process.exit(0);
}

const senha = await perguntar("New studio password: ");
const confirma = await perguntar("Repeat it: ");

if (senha !== confirma) {
  console.error("The two entries do not match. Nothing was written.");
  process.exit(1);
}

try {
  writeConfig({ BENCH_PASSWORD: hashPassword(senha) });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

console.log(`Password saved to ${PROJECT_ENV} as a scrypt hash — the password itself is not stored.`);
console.log("Restart the studio for it to take effect.");
