import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const webPort = Number(process.env.BENCH_WEB_PORT || 5200);
const apiPort = Number(process.env.BENCH_API_PORT || process.env.PORT || 8787);
const apiTarget = `http://localhost:${apiPort}`;
// LAN: BENCH_WEB_HOST=0.0.0.0 expõe a UI na rede local (padrão: só loopback).
const webHost = process.env.BENCH_WEB_HOST || "127.0.0.1";

export default defineConfig({
  plugins: [react()],
  server: {
    host: webHost,
    port: webPort,
    allowedHosts: true,
    proxy: {
      // xfwd repassa o IP de origem em X-Forwarded-For. Sem isto a API ve TODO
      // mundo como 127.0.0.1 (quem fala com ela e o proxy, na mesma maquina) — e
      // a trava "so grava chave quem esta na maquina" nao travaria ninguem.
      "/api": { target: apiTarget, changeOrigin: true, xfwd: true },
      "/media": { target: apiTarget, changeOrigin: true, xfwd: true },
      "/previews": { target: apiTarget, changeOrigin: true, xfwd: true },
      "/inputs": { target: apiTarget, changeOrigin: true, xfwd: true },
      "/projects": { target: apiTarget, changeOrigin: true, xfwd: true },
    },
  },
});
