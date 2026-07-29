import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { stripTelemetry, verifyTelemetryDisabled } from "./strip-opencode-telemetry"

const temporaryRoots: string[] = []

function write(root: string, file: string, content: string) {
  const target = path.join(root, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function snapshot(root: string, directory = root): Record<string, string> {
  const result: Record<string, string> = {}
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      Object.assign(result, snapshot(root, target))
      continue
    }
    result[path.relative(root, target).replaceAll("\\", "/")] = fs.readFileSync(target, "utf8")
  }
  return result
}

function modernFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evil-opencode-telemetry-"))
  temporaryRoots.push(root)

  const functionalSource = `export const requiredProductFeatures = {
  modelRegistry: "https://models.dev/api.json",
  hostedUiFallback: "https://app.opencode.ai",
  sharing: "/share",
  zenProvider: "opencode/zen",
  exaSearch: "https://mcp.exa.ai/mcp",
  updaterFlag: "OPENCODE_DISABLE_UPDATE",
}
`

  const aiSdkSource = `import * as OtelTracer from "@effect/opentelemetry/Tracer"
import * as Option from "effect/Option"

export function languageModelOptions(cfg: any) {
  const tracer = cfg.experimental?.openTelemetry
    ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
    : undefined
  return {
    experimental_telemetry: {
      isEnabled: cfg.experimental?.openTelemetry,
      tracer,
    },
  }
}
`

  const files: Record<string, string> = {
    "packages/opencode/package.json": `{"name":"opencode-fixture"}`,
    "packages/opencode/src/session/llm.ts": aiSdkSource,
    "packages/opencode/src/agent/agent.ts": aiSdkSource,
    "packages/opencode/src/provider/models.ts": functionalSource,
    "packages/opencode/src/control-plane/workspace.ts": `export const env = {
  FUNCTIONAL_SETTING: process.env.FUNCTIONAL_SETTING,
  OTEL_EXPORTER_OTLP_HEADERS: process.env.OTEL_EXPORTER_OTLP_HEADERS,
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  OTEL_RESOURCE_ATTRIBUTES: process.env.OTEL_RESOURCE_ATTRIBUTES,
  ANOTHER_FUNCTIONAL_SETTING: process.env.ANOTHER_FUNCTIONAL_SETTING,
}
`,
    "packages/core/src/observability/otlp.ts": `import { Layer } from "effect"
import { OtlpLogger } from "effect/unstable/observability"
import { Flag } from "../flag/flag"

const endpoint = Flag.OTEL_EXPORTER_OTLP_ENDPOINT

const headers = Flag.OTEL_EXPORTER_OTLP_HEADERS
  ? { Authorization: Flag.OTEL_EXPORTER_OTLP_HEADERS }
  : undefined

function resourceAttributes() {
  return {}
}

export function loggers() {
  if (!endpoint) return []
  return [OtlpLogger.make({ url: \`\${endpoint}/v1/logs\`, headers })]
}

export async function tracingLayer() {
  if (!endpoint) return Layer.empty
  const OTLP = await import("@opentelemetry/exporter-trace-otlp-http")
  return new OTLP.OTLPTraceExporter({ url: \`\${endpoint}/v1/traces\`, headers })
}
`,
    "packages/core/src/observability.ts": `import { NodeFileSystem } from "@effect/platform-node"
import { Otlp } from "./observability/otlp"
import { Logging } from "./observability/logging"

export const layer = Logger.layer([...Logging.loggers(), ...Otlp.loggers()]).pipe(
  Layer.provide(NodeFileSystem.layer),
)
`,
    "packages/app/src/entry.tsx": `import * as Sentry from "@sentry/solid"

Sentry.init({ dsn: import.meta.env.VITE_SENTRY_DSN })
`,
    "packages/app/src/pages/error.tsx": `import * as Sentry from '@sentry/solid'

export const report = <Show when={Sentry.isEnabled}>report</Show>
`,
    "packages/app/vite.config.ts": `import { sentryVitePlugin } from "@sentry/vite-plugin"

export default { plugins: [sentryVitePlugin({ authToken: "fixture" })] }
`,
    "packages/desktop/src/renderer/index.tsx": `import * as Sentry from "@sentry/solid"

Sentry.init({ dsn: "fixture" })
`,
    "packages/desktop/electron.vite.config.ts": `import { sentryVitePlugin } from "@sentry/vite-plugin"

export default { plugins: [sentryVitePlugin({ authToken: "fixture" })] }
`,
  }

  for (const [file, content] of Object.entries(files)) write(root, file, content)
  return { root, functionalSource }
}

function legacyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evil-opencode-telemetry-legacy-"))
  temporaryRoots.push(root)
  write(root, "packages/opencode/package.json", `{"name":"opencode-legacy-fixture"}`)
  write(
    root,
    "packages/opencode/src/effect/observability.ts",
    `import { Effect, Layer, Logger } from "effect"
import { OtlpLogger } from "effect/unstable/observability"
import { EffectLogger } from "@/effect/logger"

export namespace Observability {
  const base = Flag.OTEL_EXPORTER_OTLP_ENDPOINT
  const logs = Logger.layer([EffectLogger.logger, OtlpLogger.make({ url: \`\${base}/v1/logs\` })])
  const traces = async () => {
    const OTLP = await import("@opentelemetry/exporter-trace-otlp-http")
    return new OTLP.OTLPTraceExporter({ url: \`\${base}/v1/traces\` })
  }
  export const layer = !base ? EffectLogger.layer : Layer.unwrap(Effect.promise(traces))
}
`,
  )
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("stripTelemetry on a modern OpenCode checkout", () => {
  test("disables exporters and error reporting without removing product features or local logging", () => {
    const { root, functionalSource } = modernFixture()

    const result = stripTelemetry(root)

    expect(result.warnings).toEqual([])
    expect(result.changes.length).toBeGreaterThan(0)
    expect(verifyTelemetryDisabled(root)).toEqual([])

    for (const file of ["packages/opencode/src/session/llm.ts", "packages/opencode/src/agent/agent.ts"]) {
      const source = fs.readFileSync(path.join(root, file), "utf8")
      expect(source).toContain("isEnabled: false")
      expect(source).toContain("const tracer: any = undefined")
      expect(source).not.toContain("openTelemetry")
      expect(source).not.toContain("@effect/opentelemetry/Tracer")
      expect(source).not.toContain("effect/Option")
    }

    const otlp = fs.readFileSync(path.join(root, "packages/core/src/observability/otlp.ts"), "utf8")
    expect(otlp).toContain("export function loggers()")
    expect(otlp).toContain("return []")
    expect(otlp).toContain("return Layer.empty")
    expect(otlp).not.toContain("OTLPTraceExporter")
    expect(otlp).not.toContain("OtlpLogger")
    expect(otlp).not.toContain("/v1/traces")
    expect(otlp).not.toContain("/v1/logs")

    const observability = fs.readFileSync(path.join(root, "packages/core/src/observability.ts"), "utf8")
    expect(observability).toContain("Logging.loggers()")
    expect(observability).toContain("NodeFileSystem.layer")
    expect(observability).toContain('from "./observability/otlp"')

    const workspace = fs.readFileSync(path.join(root, "packages/opencode/src/control-plane/workspace.ts"), "utf8")
    expect(workspace).toContain("FUNCTIONAL_SETTING")
    expect(workspace).toContain("ANOTHER_FUNCTIONAL_SETTING")
    expect(workspace).not.toContain("OTEL_EXPORTER_OTLP")
    expect(workspace).not.toContain("OTEL_RESOURCE_ATTRIBUTES")

    expect(fs.readFileSync(path.join(root, "packages/app/src/entry.tsx"), "utf8")).toContain('from "@/sentry-disabled"')
    expect(fs.readFileSync(path.join(root, "packages/app/src/pages/error.tsx"), "utf8")).toContain(
      'from "@/sentry-disabled"',
    )
    expect(fs.readFileSync(path.join(root, "packages/app/src/pages/error.tsx"), "utf8")).toContain(
      "when={Sentry.isEnabled()}",
    )
    expect(fs.readFileSync(path.join(root, "packages/desktop/src/renderer/index.tsx"), "utf8")).toContain(
      'from "../sentry-disabled"',
    )
    for (const shim of ["packages/app/src/sentry-disabled.ts", "packages/desktop/src/sentry-disabled.ts"]) {
      const source = fs.readFileSync(path.join(root, shim), "utf8")
      expect(source).toContain("export const isEnabled = () => false")
      expect(source).toContain("export function captureException")
    }
    for (const config of ["packages/app/vite.config.ts", "packages/desktop/electron.vite.config.ts"]) {
      const source = fs.readFileSync(path.join(root, config), "utf8")
      expect(source).toContain("const sentryVitePlugin = (..._args: unknown[]) => false")
      expect(source).not.toContain('from "@sentry/vite-plugin"')
    }

    expect(fs.readFileSync(path.join(root, "packages/opencode/src/provider/models.ts"), "utf8")).toBe(functionalSource)
  })

  test("is idempotent and its verifier rejects the unpatched fixture", () => {
    const { root } = modernFixture()

    const originalErrors = verifyTelemetryDisabled(root)
    expect(originalErrors.some((error) => error.includes("active Sentry import remains"))).toBe(true)
    expect(originalErrors.some((error) => error.includes("AI SDK telemetry"))).toBe(true)
    expect(originalErrors.some((error) => error.includes("OpenTelemetry exporter import"))).toBe(true)

    stripTelemetry(root)
    const once = snapshot(root)
    const second = stripTelemetry(root)

    expect(second).toEqual({ changes: [], warnings: [] })
    expect(snapshot(root)).toEqual(once)
    expect(verifyTelemetryDisabled(root)).toEqual([])
  })

  test("preserves the local logger in the known legacy observability module", () => {
    const root = legacyFixture()

    stripTelemetry(root)

    const source = fs.readFileSync(path.join(root, "packages/opencode/src/effect/observability.ts"), "utf8")
    expect(source).toContain('import { EffectLogger } from "@/effect/logger"')
    expect(source).toContain("export const layer = EffectLogger.layer")
    expect(source).not.toContain("OtlpLogger")
    expect(source).not.toContain("OTLPTraceExporter")
    expect(verifyTelemetryDisabled(root)).toEqual([])
  })
})
