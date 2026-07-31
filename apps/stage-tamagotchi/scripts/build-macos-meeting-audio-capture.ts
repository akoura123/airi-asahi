import process from 'node:process'

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Builds the ScreenCaptureKit helper for the current macOS architecture. */
function buildMacOSMeetingAudioCapture(): void {
  if (process.platform !== 'darwin')
    return

  const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64'
  const source = join(packageRoot, 'native', 'meeting-media', 'macos-application-audio', 'main.swift')
  const output = join(packageRoot, 'native', 'meeting-media', 'bin', `darwin-${process.arch}`, 'airi-meeting-audio-capture')
  mkdirSync(dirname(output), { recursive: true })

  execFileSync('xcrun', [
    'swiftc',
    '-O',
    '-parse-as-library',
    '-target',
    `${architecture}-apple-macos13.0`,
    '-framework',
    'AppKit',
    '-framework',
    'ScreenCaptureKit',
    '-framework',
    'CoreMedia',
    '-framework',
    'CoreAudio',
    source,
    '-o',
    output,
  ], { stdio: 'inherit' })
  chmodSync(output, 0o755)
}

buildMacOSMeetingAudioCapture()
