// Download the exported runtime before Shiny begins its synchronous package loads.
const status = document.getElementById("startup-status");
const detail = document.getElementById("startup-detail");
const progress = document.getElementById("startup-progress");
const retry = document.getElementById("startup-retry");
retry.addEventListener("click", () => window.location.reload());

function showError(error) {
  console.error("Calculator startup:", error);
  status.textContent = "The calculator could not finish loading.";
  detail.textContent = `${error.message} Check your connection and retry. Completed downloads are saved.`;
  progress.hidden = true;
  retry.hidden = false;
}

async function prepareWorker() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("This browser does not support the required service worker.");
  }
  const registration = await navigator.serviceWorker.register("./shinylive-sw.js", {
    type: "module", updateViaCache: "none"
  });
  await registration.update();
  const worker = registration.installing || registration.waiting;
  if (worker && worker.state !== "activated") {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("The app update is waiting. Close other calculator tabs and retry.")), 45000);
      const check = () => {
        if (worker.state === "activated") {
          clearTimeout(timeout);
          resolve();
        } else if (worker.state === "redundant") {
          clearTimeout(timeout);
          reject(new Error("The app update could not be installed."));
        }
      };
      worker.addEventListener("statechange", check);
      check();
    });
  }
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller || !window.crossOriginIsolated) {
    if (sessionStorage.getItem("exmort-isolation-reload") === "1") {
      throw new Error("Browser isolation could not be enabled. Close this tab and open the app again.");
    }
    sessionStorage.setItem("exmort-isolation-reload", "1");
    window.location.reload();
    return false;
  }
  sessionStorage.removeItem("exmort-isolation-reload");
  return true;
}

async function downloadAssets() {
  const manifestResponse = await fetch("./exmort-assets.json", {cache: "no-store"});
  if (!manifestResponse.ok) throw new Error(`File list returned HTTP ${manifestResponse.status}.`);
  const manifest = await manifestResponse.json();
  const cache = await caches.open(`${manifest.version}::exmort:${new URL("./", location.href).href}`);
  const totalBytes = manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0);
  let completedBytes = 0;
  let completed = 0;
  let next = 0;
  let failed = false;
  const partialBytes = new Map();
  const update = () => {
    const readyBytes = completedBytes + Array.from(partialBytes.values()).reduce((sum, bytes) => sum + bytes, 0);
    progress.value = 100 * readyBytes / totalBytes;
    status.textContent = `Preparing app files: ${completed} of ${manifest.assets.length}`;
    detail.textContent = `${(readyBytes / 1048576).toFixed(1)} of ${(totalBytes / 1048576).toFixed(1)} MB ready. Keep this tab open; downloaded files are saved for later visits.`;
  };
  async function downloadParts(asset, signal) {
    const data = new Uint8Array(asset.bytes);
    let partIndex = 0;
    let received = 0;
    async function downloadPart() {
      while (partIndex < asset.parts.length) {
        const part = asset.parts[partIndex++];
        const response = await fetch(part.path, {signal});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== part.bytes) throw new Error("Incomplete download part");
        data.set(bytes, part.offset);
        received += bytes.byteLength;
        partialBytes.set(asset.path, received);
        update();
      }
    }
    await Promise.all(Array.from({length: 4}, downloadPart));
    return new Response(data, {headers: {"Content-Type": "application/octet-stream"}});
  }
  update();
  async function download() {
    while (!failed && next < manifest.assets.length) {
      const asset = manifest.assets[next++];
      let success = false;
      for (let attempt = 0; attempt < 3 && !success; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Math.max(90000, 30000 + asset.bytes / 32768 * 1000));
        try {
          const localUrl = new URL(asset.path, location.href).href;
          const cached = attempt === 0 ? await cache.match(localUrl) : null;
          const source = asset.mirror && attempt < 2 ? asset.mirror : localUrl;
          const response = cached || (asset.parts
            ? await downloadParts(asset, controller.signal)
            : await fetch(source, {signal: controller.signal}));
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.arrayBuffer();
          if (data.byteLength !== asset.bytes) throw new Error("Incomplete or outdated file");
          const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), byte => byte.toString(16).padStart(2, "0")).join("");
          if (hash !== asset.sha256) throw new Error("File checksum did not match");
          if (!cached) {
            const headers = new Headers(response.headers);
            headers.delete("Content-Encoding");
            headers.set("Content-Length", String(data.byteLength));
            headers.set("Cross-Origin-Embedder-Policy", "require-corp");
            headers.set("Cross-Origin-Opener-Policy", "same-origin");
            headers.set("Cross-Origin-Resource-Policy", "cross-origin");
            await cache.put(localUrl, new Response(data, {status: 200, headers}));
          }
          success = true;
        } catch (error) {
          controller.abort();
          partialBytes.delete(asset.path);
          if (attempt === 2) {
            failed = true;
            throw new Error(`Could not download ${asset.path.split("/").pop()} (${error.message}).`);
          }
        } finally {
          clearTimeout(timeout);
        }
      }
      completedBytes += asset.bytes;
      partialBytes.delete(asset.path);
      completed++;
      update();
    }
  }
  await Promise.all(Array.from({length: 6}, download));
}

async function launchApp() {
  status.textContent = "Starting R and loading the calculator...";
  detail.textContent = "All app files are ready. The calculator runs inside your browser.";
  progress.removeAttribute("value");
  const {runExportedApp} = await import("./shinylive/shinylive.js");
  await runExportedApp({id: "root", appEngine: "r", relPath: ""});
  await new Promise((resolve, reject) => {
    const started = performance.now();
    const timer = setInterval(() => {
      const frame = document.querySelector("#root iframe");
      if (frame?.contentDocument?.querySelector(".navbar")) {
        clearInterval(timer);
        document.getElementById("startup").remove();
        resolve();
      } else if (performance.now() - started > 180000) {
        clearInterval(timer);
        reject(new Error("R initialization took longer than expected."));
      }
    }, 250);
  });
}

async function main() {
  const pageUrl = new URL(window.location.href);
  if (pageUrl.searchParams.get("coi") !== "1") {
    pageUrl.searchParams.set("coi", "1");
    window.location.replace(pageUrl.href);
    return;
  }
  if (!await prepareWorker()) return;
  await downloadAssets();
  await launchApp();
}

main().catch(showError);
