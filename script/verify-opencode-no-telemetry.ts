#!/usr/bin/env bun

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const binary = path.resolve(process.argv[2] ?? "")
if (!process.argv[2] || !fs.existsSync(binary)) {
  throw new Error("Usage: bun script/verify-opencode-no-telemetry.ts <opencode-binary>")
}

const received: string[] = []
const collector = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    received.push(new URL(request.url).pathname)
    return new Response(null, { status: 200 })
  },
})

const reservation = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    return new Response(null, { status: 503 })
  },
})
const serverPort = reservation.port
await reservation.stop(true)

const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-no-telemetry-"))
const child = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(serverPort), "--print-logs"], {
  cwd: home,
  env: {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.port}`,
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=evil-opencode-runtime-probe",
    OTEL_RESOURCE_ATTRIBUTES: "test.runtime=no-telemetry",
  },
  stdout: "pipe",
  stderr: "pipe",
})

let started = false
let output = ""
try {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) break
    try {
      await fetch(`http://127.0.0.1:${serverPort}/global/health`, {
        signal: AbortSignal.timeout(250),
      })
      started = true
      break
    } catch {
      await Bun.sleep(150)
    }
  }
  if (started) {
    // The original OTLP logger sends immediately; the trace batch processor flushes on a timer.
    await Bun.sleep(6_000)
  }
} finally {
  child.kill()
  await Promise.race([child.exited, Bun.sleep(5_000)])
  if (child.exitCode === null) {
    child.kill(9)
    await child.exited
  }
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  output = `${stdout}\n${stderr}`
  await collector.stop(true)
  fs.rmSync(home, { recursive: true, force: true })
}

if (!started) throw new Error(`OpenCode runtime probe failed:\n${output}`)
if (received.length) {
  throw new Error(`Telemetry collector received unexpected requests: ${received.join(", ")}\n${output}`)
}

console.log("Runtime telemetry probe passed: collector received 0 requests")
