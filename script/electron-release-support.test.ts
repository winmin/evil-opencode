import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { mergeElectronUpdaterYml } from "./merge-electron-updater-yml"
import { writeElectronReleaseConfig } from "./write-opencode-electron-release-config"

const roots: string[] = []

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evil-opencode-electron-"))
  roots.push(root)
  return root
}

function write(root: string, file: string, content: string) {
  const target = path.join(root, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function metadata(version: string, url: string) {
  return `version: ${version}\nfiles:\n  - url: ${url}\n    sha512: digest-${url}\n    size: 123\nreleaseDate: '2026-07-29T00:00:00.000Z'\n`
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("Electron release support", () => {
  test("generates an executable unsigned config that targets this fork", async () => {
    const root = temporaryRoot()
    write(
      root,
      "packages/desktop/electron-builder.config.ts",
      'import type { Configuration } from "electron-builder"\nexport default {}',
    )
    write(
      root,
      "packages/desktop/package.json",
      JSON.stringify({ scripts: { build: "electron-vite build", package: "electron-builder" } }),
    )

    const output = writeElectronReleaseConfig(root, "WinMin/evil-opencode")
    const config = fs.readFileSync(output, "utf8")
    expect(config).toContain('owner: "WinMin"')
    expect(config).toContain('repo: "evil-opencode"')
    expect(config).toContain("identity: null")
    expect(config).toContain("notarize: false")
    expect(config).toContain("sign: false")

    const generated = (await import(pathToFileURL(output).href)).default as Record<string, any>
    expect(generated.publish).toEqual({ provider: "github", owner: "WinMin", repo: "evil-opencode", channel: "latest" })
    expect(generated.mac.identity).toBeNull()
    expect(generated.mac.notarize).toBeFalse()
    expect(generated.dmg.sign).toBeFalse()
  })

  test("merges multi-architecture updater metadata and rejects version drift", () => {
    const root = temporaryRoot()
    const artifacts = path.join(root, "artifacts")
    const release = path.join(root, "release")
    const version = "1.18.9"
    const inputs = [
      ["opencode-desktop-windows-x64", "latest.yml", "opencode-desktop-win-x64.exe"],
      ["opencode-desktop-darwin-x64", "latest-mac.yml", "opencode-desktop-mac-x64.zip"],
      ["opencode-desktop-darwin-arm64", "latest-mac.yml", "opencode-desktop-mac-arm64.zip"],
      ["opencode-desktop-linux-x64", "latest-linux.yml", "opencode-desktop-linux-x64.AppImage"],
      ["opencode-desktop-linux-arm64", "latest-linux-arm64.yml", "opencode-desktop-linux-arm64.AppImage"],
    ]
    for (const [artifact, filename, url] of inputs) write(artifacts, `${artifact}/${filename}`, metadata(version, url))

    expect(mergeElectronUpdaterYml(artifacts, release, version)).toEqual([
      "latest.yml",
      "latest-mac.yml",
      "latest-linux.yml",
      "latest-linux-arm64.yml",
    ])
    const mac = fs.readFileSync(path.join(release, "latest-mac.yml"), "utf8")
    expect(mac).toContain("opencode-desktop-mac-arm64.zip")
    expect(mac).toContain("opencode-desktop-mac-x64.zip")

    write(artifacts, "opencode-desktop-linux-x64/latest-linux.yml", metadata("1.18.8", "stale.AppImage"))
    expect(() => mergeElectronUpdaterYml(artifacts, release, version)).toThrow("expected version 1.18.9")
  })
})
