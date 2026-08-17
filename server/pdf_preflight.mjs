import { readFile, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";

function chromeDump(htmlPath) {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return new Promise((resolvePromise, reject) => {
    const child = spawn(chrome, [
      "--headless=new", "--disable-gpu", "--dump-dom",
      "--run-all-compositor-stages-before-draw", "--virtual-time-budget=750",
      `file://${htmlPath}`,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(stderr || `Chrome exited ${code}`)));
  });
}

export async function inspectTextOverflow(htmlPath) {
  const source = await readFile(htmlPath, "utf8");
  const probe = `<script>(function(){
    const selector = 'h1,h2,h3,h4,h5,h6,p,li,dt,dd,th,td,blockquote,figcaption,.big';
    const offenders = [...document.querySelectorAll(selector)].filter((el) => {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      const parent = el.parentElement;
      if (!parent) return false;
      const parentRect = parent.getBoundingClientRect();
      const parentStyle = getComputedStyle(parent);
      const left = parentRect.left + parseFloat(parentStyle.paddingLeft || 0);
      const right = parentRect.right - parseFloat(parentStyle.paddingRight || 0);
      return el.scrollWidth > el.clientWidth + 4 || rect.left < left - 2 || rect.right > right + 2;
    }).map((el) => ({
      element: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).trim().replace(/\\s+/g, '.') : ''),
      text: (el.textContent || '').trim().slice(0, 120),
      client: [el.clientWidth, el.clientHeight],
      scroll: [el.scrollWidth, el.scrollHeight]
    }));
    document.body.textContent = 'BENCH_OVERFLOW_B64:' + btoa(unescape(encodeURIComponent(JSON.stringify(offenders))));
  })();</script>`;
  const probePath = join(dirname(htmlPath), ".bench-print-preflight.html");
  const instrumented = /<\/body>/i.test(source)
    ? source.replace(/<\/body>/i, `${probe}</body>`)
    : `${source}${probe}`;
  await writeFile(probePath, instrumented);
  try {
    const dumped = await chromeDump(probePath);
    const encoded = dumped.match(/BENCH_OVERFLOW_B64:([A-Za-z0-9+/=]+)/)?.[1];
    if (!encoded) throw new Error("Print preflight did not return a result");
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } finally {
    await unlink(probePath).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const target = resolve(process.argv[2] ?? "");
  console.log(JSON.stringify(await inspectTextOverflow(target), null, 2));
}
