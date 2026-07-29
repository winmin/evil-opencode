import fs from "node:fs"
import path from "node:path"

type FileEntry = {
  url: string
  sha512: string
  size: number
  blockMapSize?: number
}

type LatestYml = {
  version: string
  releaseDate: string
  files: FileEntry[]
}

function parse(content: string): LatestYml {
  let version = ""
  let releaseDate = ""
  const files: FileEntry[] = []
  let current: Partial<FileEntry> | undefined

  const flush = () => {
    if (current?.url && current.sha512 && current.size) files.push(current as FileEntry)
    current = undefined
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    const indented = line.startsWith("    ") || line.startsWith("  -")
    if (line.startsWith("version:")) version = line.slice("version:".length).trim()
    else if (line.startsWith("releaseDate:"))
      releaseDate = line.slice("releaseDate:".length).trim().replace(/^'|'$/g, "")
    else if (trimmed.startsWith("- url:")) {
      flush()
      current = { url: trimmed.slice("- url:".length).trim() }
    } else if (indented && current && trimmed.startsWith("sha512:")) {
      current.sha512 = trimmed.slice("sha512:".length).trim()
    } else if (indented && current && trimmed.startsWith("size:")) {
      current.size = Number(trimmed.slice("size:".length).trim())
    } else if (indented && current && trimmed.startsWith("blockMapSize:")) {
      current.blockMapSize = Number(trimmed.slice("blockMapSize:".length).trim())
    } else if (!indented && current) {
      flush()
    }
  }
  flush()

  if (
    !version ||
    !releaseDate ||
    files.length === 0 ||
    files.some((file) => !Number.isFinite(file.size) || file.size <= 0)
  ) {
    throw new Error("Invalid or empty electron-updater metadata")
  }
  return { version, releaseDate, files }
}

function serialize(data: LatestYml) {
  const lines = [`version: ${data.version}`, "files:"]
  for (const file of data.files) {
    lines.push(`  - url: ${file.url}`)
    lines.push(`    sha512: ${file.sha512}`)
    lines.push(`    size: ${file.size}`)
    if (file.blockMapSize) lines.push(`    blockMapSize: ${file.blockMapSize}`)
  }
  lines.push(`releaseDate: '${data.releaseDate}'`)
  return lines.join("\n") + "\n"
}

function read(artifacts: string, artifact: string, filename: string, expectedVersion: string) {
  const file = path.join(artifacts, artifact, filename)
  if (!fs.existsSync(file)) throw new Error(`Missing updater metadata: ${file}`)
  const parsed = parse(fs.readFileSync(file, "utf8"))
  if (parsed.version !== expectedVersion) {
    throw new Error(`${file}: expected version ${expectedVersion}, received ${parsed.version}`)
  }
  return parsed
}

function merge(...metadata: LatestYml[]) {
  const first = metadata[0]
  return {
    version: first.version,
    releaseDate: first.releaseDate,
    files: metadata.flatMap((item) => item.files),
  }
}

export function mergeElectronUpdaterYml(artifacts: string, release: string, version: string) {
  const windows = read(artifacts, "opencode-desktop-windows-x64", "latest.yml", version)
  const macX64 = read(artifacts, "opencode-desktop-darwin-x64", "latest-mac.yml", version)
  const macArm64 = read(artifacts, "opencode-desktop-darwin-arm64", "latest-mac.yml", version)
  const linuxX64 = read(artifacts, "opencode-desktop-linux-x64", "latest-linux.yml", version)
  const linuxArm64 = read(artifacts, "opencode-desktop-linux-arm64", "latest-linux-arm64.yml", version)

  fs.mkdirSync(release, { recursive: true })
  const output: Record<string, LatestYml> = {
    "latest.yml": windows,
    "latest-mac.yml": merge(macArm64, macX64),
    "latest-linux.yml": linuxX64,
    "latest-linux-arm64.yml": linuxArm64,
  }

  for (const [filename, metadata] of Object.entries(output)) {
    const urls = new Set(metadata.files.map((file) => file.url))
    if (urls.size !== metadata.files.length) throw new Error(`${filename}: duplicate updater file entries`)
    fs.writeFileSync(path.join(release, filename), serialize(metadata))
  }
  return Object.keys(output)
}

if (import.meta.main) {
  const [artifacts, release, version] = Bun.argv.slice(2)
  if (!artifacts || !release || !version) {
    throw new Error("Usage: bun script/merge-electron-updater-yml.ts <artifacts-dir> <release-dir> <version>")
  }
  console.log(mergeElectronUpdaterYml(artifacts, release, version).join("\n"))
}
