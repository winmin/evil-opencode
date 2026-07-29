#!/usr/bin/env bun

import fs from "node:fs"
import path from "node:path"

type Change = {
  file: string
  reason: string
}

export type StripResult = {
  changes: Change[]
  warnings: string[]
}

const marker = "evil-opencode: telemetry disabled at build time"

function exists(root: string, file: string) {
  return fs.existsSync(path.join(root, file))
}

function read(root: string, file: string) {
  return fs.readFileSync(path.join(root, file), "utf8")
}

function files(root: string, directory: string) {
  const base = path.join(root, directory)
  if (!fs.existsSync(base)) return []
  const result: string[] = []
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) {
        visit(target)
        continue
      }
      if (entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name)) {
        result.push(path.relative(root, target).replaceAll("\\", "/"))
      }
    }
  }
  visit(base)
  return result
}

function relativeImport(from: string, to: string) {
  const result = path
    .relative(path.dirname(from), to)
    .replaceAll("\\", "/")
    .replace(/\.[^.]+$/, "")
  return result.startsWith(".") ? result : `./${result}`
}

function replaceFunctionBody(content: string, name: string, body: string) {
  const signature = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)[^{]*\\{`, "m")
  const match = signature.exec(content)
  if (!match) throw new Error(`Unable to locate ${name}() while disabling OTLP`)

  const open = match.index + match[0].lastIndexOf("{")
  let depth = 0
  for (let index = open; index < content.length; index++) {
    if (content[index] === "{") depth++
    if (content[index] !== "}") continue
    depth--
    if (depth !== 0) continue
    return content.slice(0, open + 1) + body + content.slice(index)
  }
  throw new Error(`Unable to find the end of ${name}() while disabling OTLP`)
}

function update(root: string, file: string, reason: string, transform: (content: string) => string, changes: Change[]) {
  if (!exists(root, file)) return false
  const before = read(root, file)
  const after = transform(before)
  if (after === before) return false
  fs.writeFileSync(path.join(root, file), after)
  changes.push({ file, reason })
  return true
}

function disableAiSdkTelemetry(root: string, changes: Change[]) {
  for (const file of ["packages/opencode/src/session/llm.ts", "packages/opencode/src/agent/agent.ts"]) {
    update(
      root,
      file,
      "hard-disable AI SDK span recording while keeping the config schema compatible",
      (content) => {
        let result = content.replaceAll("cfg.experimental?.openTelemetry", "false")
        result = result.replace(
          /const tracer = false\s*\?\s*Option\.getOrUndefined\(yield\* Effect\.serviceOption\(OtelTracer\.OtelTracer\)\)\s*:\s*undefined/g,
          "const tracer: any = undefined",
        )
        result = result.replace(/^import \* as OtelTracer from "@effect\/opentelemetry\/Tracer"\r?\n/m, "")
        const withoutOptionImport = result.replace(/^import \* as Option from "effect\/Option"\r?\n/m, "")
        if (!/\bOption\b/.test(withoutOptionImport)) result = withoutOptionImport
        return result
      },
      changes,
    )
  }
}

function disableModernOtlp(root: string, changes: Change[]) {
  const otlp = "packages/core/src/observability/otlp.ts"
  if (!exists(root, otlp)) return

  update(
    root,
    otlp,
    "replace the OTLP exporter with a no-op while retaining resource helpers",
    (content) => {
      if (content.includes(marker) && !content.includes("OTLPTraceExporter") && !content.includes("OtlpLogger")) {
        return content
      }
      if (!content.includes("OTLPTraceExporter") && !content.includes("OtlpLogger")) return content
      let result = replaceFunctionBody(content, "loggers", "\n  return []\n")
      result = replaceFunctionBody(result, "tracingLayer", "\n  return Layer.empty\n")
      result = result.replace(/^import \{ OtlpLogger \} from "effect\/unstable\/observability"\r?\n/m, "")

      const beforeEndpoint = result
      result = result.replace(/^const endpoint = Flag\.OTEL_EXPORTER_OTLP_ENDPOINT\r?\n\r?\n/m, "")
      if (result === beforeEndpoint) {
        throw new Error(`${otlp}: unknown exporter endpoint setup; refusing to alter unrelated upstream code`)
      }
      const beforeHeaders = result
      result = result.replace(/^const headers =[\s\S]*?^\s*: undefined\r?\n\r?\n/m, "")
      if (result === beforeHeaders) {
        throw new Error(`${otlp}: unknown exporter header setup; refusing to alter unrelated upstream code`)
      }

      const resourceStart = result.indexOf("function resourceAttributes()")
      if (resourceStart === -1) {
        throw new Error(`${otlp}: resource helper was not found; refusing to alter unrelated upstream code`)
      }
      result =
        result.slice(0, resourceStart) +
        `// ${marker}. Resource construction remains for API/test compatibility,\n` +
        "// but no logger or trace exporter can be created by release binaries.\n" +
        result.slice(resourceStart)

      for (const value of ["OTLPTraceExporter", "OtlpLogger", "/v1/traces", "/v1/logs"]) {
        if (result.includes(value)) throw new Error(`${otlp}: failed to remove exporter capability (${value})`)
      }
      return result
    },
    changes,
  )

  const observability = "packages/core/src/observability.ts"
  if (!exists(root, observability) || !read(root, observability).includes("Logging.loggers()")) {
    throw new Error(`${observability}: local logging layer was not found; refusing to strip observability`)
  }

  const workspace = "packages/opencode/src/control-plane/workspace.ts"
  update(
    root,
    workspace,
    "do not forward telemetry exporter settings into remote workspaces",
    (content) =>
      content.replace(
        /^\s*OTEL_EXPORTER_OTLP_HEADERS: process\.env\.OTEL_EXPORTER_OTLP_HEADERS,\r?\n\s*OTEL_EXPORTER_OTLP_ENDPOINT: process\.env\.OTEL_EXPORTER_OTLP_ENDPOINT,\r?\n\s*OTEL_RESOURCE_ATTRIBUTES: process\.env\.OTEL_RESOURCE_ATTRIBUTES,\r?\n/m,
        "",
      ),
    changes,
  )
}

function disableLegacyOtlp(root: string, changes: Change[]) {
  const file = "packages/opencode/src/effect/observability.ts"
  if (!exists(root, file)) return
  update(
    root,
    file,
    "replace the legacy OTLP layer with the existing local logger",
    (content) => {
      if (!content.includes("OTEL_EXPORTER_OTLP_ENDPOINT")) return content
      for (const anchor of [
        'import { EffectLogger } from "@/effect/logger"',
        "OtlpLogger",
        "const logs = Logger.layer",
        "const traces = async () =>",
        "export const layer = !base",
      ]) {
        if (!content.includes(anchor)) {
          throw new Error(`${file}: unknown legacy observability shape; refusing to overwrite unrelated upstream code`)
        }
      }
      return `import { EffectLogger } from "@/effect/logger"

// ${marker}. Preserve local logging, but never install an exporter.
export namespace Observability {
  export const enabled = false
  export const layer = EffectLogger.layer
}
`
    },
    changes,
  )
}

function disableSentry(root: string, changes: Change[]) {
  const appSources = files(root, "packages/app/src")
  const desktopSources = files(root, "packages/desktop/src")
  const sentrySolidImport = /from\s+["']@sentry\/solid["']/
  const appUsesSentry = appSources.some((file) => sentrySolidImport.test(read(root, file)))
  const desktopUsesSentry = desktopSources.some((file) => sentrySolidImport.test(read(root, file)))

  if (appUsesSentry) {
    const shim = "packages/app/src/sentry-disabled.ts"
    fs.writeFileSync(
      path.join(root, shim),
      `// ${marker}
type Integration = { name: string }
type InitOptions = {
  integrations?: (integrations: Integration[]) => Integration[]
  [key: string]: unknown
}

export const isEnabled = () => false
export function init(_options?: InitOptions) {}
export function captureException(_error: unknown) {
  return undefined
}
`,
    )
    changes.push({ file: shim, reason: "provide an API-compatible no-op Sentry shim" })
    for (const file of appSources) {
      update(
        root,
        file,
        "route browser error reporting to the no-op shim",
        (content) =>
          content
            .replace(/from\s+["']@sentry\/solid["']/g, 'from "@/sentry-disabled"')
            .replaceAll("when={Sentry.isEnabled}", "when={Sentry.isEnabled()}"),
        changes,
      )
    }
  }

  if (desktopUsesSentry) {
    const shim = "packages/desktop/src/sentry-disabled.ts"
    fs.writeFileSync(
      path.join(root, shim),
      `// ${marker}
type Integration = { name: string }
type InitOptions = {
  integrations?: (integrations: Integration[]) => Integration[]
  [key: string]: unknown
}

export const isEnabled = () => false
export function init(_options?: InitOptions) {}
export function captureException(_error: unknown) {
  return undefined
}
`,
    )
    changes.push({ file: shim, reason: "provide a desktop no-op Sentry shim" })
    for (const file of desktopSources) {
      const specifier = relativeImport(file, shim)
      update(
        root,
        file,
        "route desktop error reporting to the no-op shim",
        (content) => content.replace(/from\s+["']@sentry\/solid["']/g, `from "${specifier}"`),
        changes,
      )
    }
  }

  for (const file of ["packages/app/vite.config.ts", "packages/desktop/electron.vite.config.ts"]) {
    update(
      root,
      file,
      "prevent the Sentry build plugin from being initialized even if secrets are present",
      (content) =>
        content.replace(
          /^import \{ sentryVitePlugin \} from ["']@sentry\/vite-plugin["']\r?\n/m,
          `// ${marker}\nconst sentryVitePlugin = (..._args: unknown[]) => false\n`,
        ),
      changes,
    )
  }
}

export function verifyTelemetryDisabled(root: string) {
  const errors: string[] = []
  const runtimeFiles = [
    ...files(root, "packages/opencode/src"),
    ...files(root, "packages/core/src"),
    ...files(root, "packages/app/src"),
    ...files(root, "packages/desktop/src"),
  ]
  const buildFiles = ["packages/app/vite.config.ts", "packages/desktop/electron.vite.config.ts"].filter((file) =>
    exists(root, file),
  )
  const capabilityPatterns = [
    { pattern: /@opentelemetry\/exporter-/, label: "OpenTelemetry exporter import" },
    { pattern: /@effect\/opentelemetry\/(?:Tracer|NodeSdk)/, label: "Effect OpenTelemetry runtime import" },
    { pattern: /\bOtlpLogger\b/, label: "OTLP logger" },
    { pattern: /\bOTLP[A-Za-z]*Exporter\b/, label: "OTLP exporter" },
    { pattern: /\/v1\/(?:logs|traces)\b/, label: "OTLP endpoint" },
  ]

  for (const file of [...runtimeFiles, ...buildFiles]) {
    const content = read(root, file)
    if (/(?:from\s+|(?:import|require)\s*\()\s*["']@sentry\//.test(content)) {
      errors.push(`${file}: active Sentry import remains`)
    }
    for (const capability of capabilityPatterns) {
      if (capability.pattern.test(content)) errors.push(`${file}: ${capability.label} remains`)
    }
    for (const match of content.matchAll(/\bexperimental_telemetry\s*:/g)) {
      const fragment = content.slice(match.index, match.index + 1200)
      if (!/^experimental_telemetry\s*:\s*\{\s*isEnabled\s*:\s*false(?:\s*[,}\n])/.test(fragment)) {
        errors.push(`${file}: AI SDK telemetry is not fixed to literal false`)
      }
    }
  }

  for (const file of ["packages/opencode/src/session/llm.ts", "packages/opencode/src/agent/agent.ts"]) {
    if (!exists(root, file)) continue
    const content = read(root, file)
    if (content.includes("openTelemetry")) errors.push(`${file}: an unhandled OpenTelemetry call site remains`)
    if (content.includes('from "@effect/opentelemetry/Tracer"') || content.includes("OtelTracer.")) {
      errors.push(`${file}: an OpenTelemetry tracer import remains`)
    }
  }

  for (const [directory, shim] of [
    ["packages/app/src", "packages/app/src/sentry-disabled.ts"],
    ["packages/desktop/src", "packages/desktop/src/sentry-disabled.ts"],
  ]) {
    const routed = files(root, directory).some((file) => read(root, file).includes("sentry-disabled"))
    if (!routed) continue
    if (!exists(root, shim)) {
      errors.push(`${shim}: Sentry imports are routed to a missing no-op shim`)
      continue
    }
    const content = read(root, shim)
    if (
      !content.includes(marker) ||
      !/export const isEnabled = \(\) => false/.test(content) ||
      !/export function init\([^)]*\) \{\}/.test(content) ||
      !/export function captureException\([^)]*\) \{\s*return undefined\s*\}/.test(content)
    ) {
      errors.push(`${shim}: Sentry shim is not verifiably disabled`)
    }
  }

  const otlp = "packages/core/src/observability/otlp.ts"
  if (exists(root, otlp)) {
    const content = read(root, otlp)
    if (!/export function loggers\(\)\s*\{\s*return \[\]\s*\}/.test(content)) {
      errors.push(`${otlp}: loggers() is not a verified no-op`)
    }
    if (!/export async function tracingLayer\(\)\s*\{\s*return Layer\.empty\s*\}/.test(content)) {
      errors.push(`${otlp}: tracingLayer() is not a verified no-op`)
    }
    const observability = "packages/core/src/observability.ts"
    if (!exists(root, observability) || !read(root, observability).includes("Logging.loggers()")) {
      errors.push(`${observability}: local logging is not verifiably preserved`)
    }
  }

  const legacyOtlp = "packages/opencode/src/effect/observability.ts"
  if (exists(root, legacyOtlp) && read(root, legacyOtlp).includes("OTEL_EXPORTER_OTLP_ENDPOINT")) {
    errors.push(`${legacyOtlp}: legacy exporter capability remains`)
  }

  const workspace = "packages/opencode/src/control-plane/workspace.ts"
  if (
    exists(root, workspace) &&
    /OTEL_EXPORTER_OTLP_(?:ENDPOINT|HEADERS)|OTEL_RESOURCE_ATTRIBUTES/.test(read(root, workspace))
  ) {
    errors.push(`${workspace}: telemetry exporter environment forwarding remains`)
  }

  return errors
}

export function stripTelemetry(root: string): StripResult {
  const target = path.resolve(root)
  if (!exists(target, "packages/opencode/package.json")) {
    throw new Error(`Not an OpenCode checkout: ${target}`)
  }

  const changes: Change[] = []
  const warnings: string[] = []
  disableAiSdkTelemetry(target, changes)
  disableModernOtlp(target, changes)
  disableLegacyOtlp(target, changes)
  disableSentry(target, changes)
  return { changes, warnings }
}

function printResult(result: StripResult) {
  for (const change of result.changes) console.log(`patched ${change.file}: ${change.reason}`)
  for (const warning of result.warnings) console.warn(`warning: ${warning}`)
  if (!result.changes.length) console.log("no changes needed")
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const check = args.includes("--check")
  const root = path.resolve(args.find((arg) => !arg.startsWith("--")) ?? ".")

  if (!check) printResult(stripTelemetry(root))
  const errors = verifyTelemetryDisabled(root)
  if (errors.length) {
    console.error("Telemetry verification failed:")
    for (const error of errors) console.error(`- ${error}`)
    process.exit(1)
  }
  console.log("Telemetry verification passed")
}
