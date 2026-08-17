import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeEnvText, validatePatch, writeConfig, describeConfig, parseEnvFile, isLoopback } from "../server/config_store.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "bench-config-"));

test("editing a key preserves comments, order, and unknown lines", () => {
  const antes = [
    "# minha configuracao",
    "FAL_KEY=velha",
    "",
    "# nao mexa nisto",
    "COISA_MINHA=42",
    "",
  ].join("\n");
  const depois = mergeEnvText(antes, { FAL_KEY: "nova" });
  assert.equal(depois, ["# minha configuracao", "FAL_KEY=nova", "", "# nao mexa nisto", "COISA_MINHA=42", ""].join("\n"));
});

test("an empty value removes the key instead of writing an empty one", () => {
  const depois = mergeEnvText("FAL_KEY=x\nAGNES_API_KEY=y\n", { FAL_KEY: "" });
  assert.equal(depois, "AGNES_API_KEY=y\n");
});

test("a new key is appended and the file always ends with a newline", () => {
  const depois = mergeEnvText("FAL_KEY=x", { AGNES_API_KEY: "y" });
  assert.ok(depois.endsWith("\n"));
  assert.deepEqual(parseEnvFile(depois).get("AGNES_API_KEY"), "y");
  assert.deepEqual(parseEnvFile(depois).get("FAL_KEY"), "x");
});

test("unknown settings and line breaks are refused", () => {
  assert.match(validatePatch({ RANDOM_THING: "x" }).error, /Unknown setting/);
  assert.match(validatePatch({ FAL_KEY: "a\nb" }).error, /line break/);
  assert.deepEqual(validatePatch({ FAL_KEY: "  espacos  " }).patch, { FAL_KEY: "espacos" });
});

test("the written file is owner-only and never left as a temp file", () => {
  const dir = tmp();
  const alvo = join(dir, ".env");
  writeConfig({ FAL_KEY: "segredo" }, { projectPath: alvo });
  assert.equal(statSync(alvo).mode & 0o777, 0o600);
  assert.equal(readFileSync(alvo, "utf8"), "FAL_KEY=segredo\n");
  assert.ok(!existsSync(`${alvo}.tmp-${process.pid}`));
});

test("no secret value ever leaves describeConfig — only presence and a tail", () => {
  const dir = tmp();
  const projeto = join(dir, ".env");
  writeFileSync(projeto, "FAL_KEY=chave-secreta-1234\n");
  const { fields } = describeConfig({ env: {}, projectPath: projeto, homePath: join(dir, "sem-home") });
  const fal = fields.find((f) => f.key === "FAL_KEY");

  assert.equal(fal.present, true);
  assert.equal(fal.source, "project_env");
  assert.equal(fal.value, null, "a secret must never carry its value");
  assert.equal(fal.masked_tail, "…1234");
  assert.ok(!JSON.stringify(fields).includes("chave-secreta"), "the full secret must not appear anywhere in the payload");
});

test("a key exported by the shell is reported as shadowing the project file", () => {
  const dir = tmp();
  const projeto = join(dir, ".env");
  writeFileSync(projeto, "FAL_KEY=do-arquivo\n");
  const { fields } = describeConfig({ env: { FAL_KEY: "do-shell" }, projectPath: projeto, homePath: join(dir, "sem-home") });
  const fal = fields.find((f) => f.key === "FAL_KEY");

  // Sem isto a tela diria "salvo" e o servidor seguiria usando a do shell.
  assert.equal(fal.shadowed, true);
  assert.equal(fal.source, "project_env");
});

test("a key that exists only in the environment is reported as exported", () => {
  const dir = tmp();
  const { fields } = describeConfig({ env: { AGNES_API_KEY: "x" }, projectPath: join(dir, "nada"), homePath: join(dir, "nada2") });
  const agnes = fields.find((f) => f.key === "AGNES_API_KEY");
  assert.equal(agnes.source, "exported");
  assert.equal(agnes.shadowed, false);
});

test("a missing key is absent, not empty", () => {
  const dir = tmp();
  const { fields } = describeConfig({ env: {}, projectPath: join(dir, "nada"), homePath: join(dir, "nada2") });
  const kie = fields.find((f) => f.key === "KIE_API_KEY");
  assert.equal(kie.present, false);
  assert.equal(kie.source, null);
  assert.equal(kie.masked_tail, null);
});

test("a client behind the dev proxy is judged by its real address, not the proxy's", () => {
  // O navegador fala com o Vite, nao com a API: quem abre o socket e sempre a
  // propria maquina. Sem olhar o X-Forwarded-For, a trava nao travaria ninguem.
  const local = { socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(isLoopback({ ...local, headers: { "x-forwarded-for": "192.168.1.50" } }), false);
  assert.equal(isLoopback({ ...local, headers: { "x-forwarded-for": "127.0.0.1" } }), true);
  assert.equal(isLoopback({ ...local, headers: {} }), true);

  // E o cabecalho so vale porque o socket ja e local: quem vem de fora nao
  // consegue abrir socket loopback, entao nao consegue forjar a origem.
  assert.equal(
    isLoopback({ socket: { remoteAddress: "192.168.1.50" }, headers: { "x-forwarded-for": "127.0.0.1" } }),
    false,
    "a forged header from the network must never grant write access",
  );
});

test("only loopback callers count as local", () => {
  assert.equal(isLoopback({ socket: { remoteAddress: "127.0.0.1" } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: "::1" } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: "::ffff:127.0.0.1" } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: "192.168.1.172" } }), false);
  assert.equal(isLoopback({ socket: { remoteAddress: "::ffff:192.168.1.50" } }), false);
  assert.equal(isLoopback({}), false);
});
