import AppKit
import CoreAudio
import CoreMedia
import Foundation
import ScreenCaptureKit

private let frameMagic = Data([0x41, 0x49, 0x52, 0x49]) // "AIRI"
private let frameProtocolVersion: UInt16 = 1
private let frameHeaderBytes: UInt16 = 40
private let float32SampleFormat: UInt16 = 1

private enum CaptureFailure: LocalizedError {
  case invalidArguments
  case sourceWindowUnavailable(CGWindowID)
  case unsupportedAudioFormat
  case malformedAudioBuffer

  var errorDescription: String? {
    switch self {
    case .invalidArguments:
      return "Expected --window-id followed by a positive macOS window identifier."
    case let .sourceWindowUnavailable(windowID):
      return "The selected meeting window \(windowID) is no longer available to ScreenCaptureKit."
    case .unsupportedAudioFormat:
      return "ScreenCaptureKit returned audio that is not Float32 linear PCM."
    case .malformedAudioBuffer:
      return "ScreenCaptureKit returned an incomplete audio buffer."
    }
  }
}

private extension Data {
  mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
    var encoded = value.littleEndian
    Swift.withUnsafeBytes(of: &encoded) { bytes in
      append(contentsOf: bytes)
    }
  }
}

private func writeDiagnostic(event: String, message: String? = nil) {
  var body: [String: Any] = ["event": event]
  if let message {
    body["message"] = message
  }
  guard let encoded = try? JSONSerialization.data(withJSONObject: body) else {
    return
  }

  var line = encoded
  line.append(0x0A)
  FileHandle.standardError.write(line)
}

/**
 * Converts ScreenCaptureKit audio sample buffers into a bounded binary frame protocol on stdout.
 *
 * Frame layout (little-endian):
 *
 * AIRI | version:u16 | headerBytes:u16 | sequence:u64 | capturedAtMs:u64 |
 * sampleRate:u32 | channels:u16 | format:u16 | frameCount:u32 | payloadBytes:u32 |
 * interleaved Float32 PCM
 */
private final class ApplicationAudioOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  let queue = DispatchQueue(label: "ai.moeru.airi.meeting-audio-capture")

  private var sequence: UInt64 = 0
  private var failed = false

  var onFailure: (@Sendable (Error) -> Void)?

  func stream(
    _ stream: SCStream,
    didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
    of outputType: SCStreamOutputType
  ) {
    guard outputType == .audio, sampleBuffer.isValid, CMSampleBufferDataIsReady(sampleBuffer), !failed else {
      return
    }

    do {
      let pcm = try interleavedFloat32(from: sampleBuffer)
      guard !pcm.samples.isEmpty else {
        return
      }
      sequence &+= 1
      writeFrame(
        samples: pcm.samples,
        frameCount: pcm.frameCount,
        sampleRate: pcm.sampleRate,
        channelCount: pcm.channelCount
      )
    }
    catch {
      fail(error)
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fail(error)
  }

  private func fail(_ error: Error) {
    guard !failed else {
      return
    }
    failed = true
    onFailure?(error)
  }

  private func interleavedFloat32(from sampleBuffer: CMSampleBuffer) throws -> (
    samples: [Float],
    frameCount: Int,
    sampleRate: UInt32,
    channelCount: UInt16
  ) {
    guard
      let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
      let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)?.pointee,
      streamDescription.mFormatID == kAudioFormatLinearPCM,
      streamDescription.mFormatFlags & kAudioFormatFlagIsFloat != 0,
      streamDescription.mBitsPerChannel == 32
    else {
      throw CaptureFailure.unsupportedAudioFormat
    }

    let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
    let channelCount = Int(streamDescription.mChannelsPerFrame)
    guard frameCount > 0, channelCount > 0, channelCount <= Int(UInt16.max) else {
      throw CaptureFailure.malformedAudioBuffer
    }

    var requiredBufferListBytes = 0
    let sizeStatus = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sampleBuffer,
      bufferListSizeNeededOut: &requiredBufferListBytes,
      bufferListOut: nil,
      bufferListSize: 0,
      blockBufferAllocator: kCFAllocatorDefault,
      blockBufferMemoryAllocator: kCFAllocatorDefault,
      flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
      blockBufferOut: nil
    )
    guard sizeStatus == noErr, requiredBufferListBytes >= MemoryLayout<AudioBufferList>.size else {
      throw CaptureFailure.malformedAudioBuffer
    }

    let rawBufferList = UnsafeMutableRawPointer.allocate(
      byteCount: requiredBufferListBytes,
      alignment: MemoryLayout<AudioBufferList>.alignment
    )
    defer { rawBufferList.deallocate() }

    let bufferList = rawBufferList.bindMemory(to: AudioBufferList.self, capacity: 1)
    var retainedBlockBuffer: CMBlockBuffer?
    let copyStatus = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sampleBuffer,
      bufferListSizeNeededOut: nil,
      bufferListOut: bufferList,
      bufferListSize: requiredBufferListBytes,
      blockBufferAllocator: kCFAllocatorDefault,
      blockBufferMemoryAllocator: kCFAllocatorDefault,
      flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
      blockBufferOut: &retainedBlockBuffer
    )
    guard copyStatus == noErr else {
      throw CaptureFailure.malformedAudioBuffer
    }

    let buffers = UnsafeMutableAudioBufferListPointer(bufferList)
    let nonInterleaved = streamDescription.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
    var samples = [Float](repeating: 0, count: frameCount * channelCount)

    if nonInterleaved {
      guard buffers.count >= channelCount else {
        throw CaptureFailure.malformedAudioBuffer
      }
      for channelIndex in 0..<channelCount {
        let buffer = buffers[channelIndex]
        guard
          let data = buffer.mData?.assumingMemoryBound(to: Float.self),
          Int(buffer.mDataByteSize) >= frameCount * MemoryLayout<Float>.size
        else {
          throw CaptureFailure.malformedAudioBuffer
        }
        for frameIndex in 0..<frameCount {
          samples[(frameIndex * channelCount) + channelIndex] = data[frameIndex]
        }
      }
    }
    else {
      guard
        let buffer = buffers.first,
        let data = buffer.mData?.assumingMemoryBound(to: Float.self),
        Int(buffer.mDataByteSize) >= samples.count * MemoryLayout<Float>.size
      else {
        throw CaptureFailure.malformedAudioBuffer
      }
      let sampleCount = samples.count
      samples.withUnsafeMutableBufferPointer { destination in
        destination.baseAddress?.update(from: data, count: sampleCount)
      }
    }

    return (
      samples,
      frameCount,
      UInt32(streamDescription.mSampleRate.rounded()),
      UInt16(channelCount)
    )
  }

  private func writeFrame(
    samples: [Float],
    frameCount: Int,
    sampleRate: UInt32,
    channelCount: UInt16
  ) {
    let payloadBytes = samples.count * MemoryLayout<Float>.size
    guard frameCount <= Int(UInt32.max), payloadBytes <= Int(UInt32.max) else {
      fail(CaptureFailure.malformedAudioBuffer)
      return
    }

    var header = Data(capacity: Int(frameHeaderBytes))
    header.append(frameMagic)
    header.appendLittleEndian(frameProtocolVersion)
    header.appendLittleEndian(frameHeaderBytes)
    header.appendLittleEndian(sequence)
    header.appendLittleEndian(UInt64((Date().timeIntervalSince1970 * 1000).rounded()))
    header.appendLittleEndian(sampleRate)
    header.appendLittleEndian(channelCount)
    header.appendLittleEndian(float32SampleFormat)
    header.appendLittleEndian(UInt32(frameCount))
    header.appendLittleEndian(UInt32(payloadBytes))

    FileHandle.standardOutput.write(header)
    samples.withUnsafeBytes { bytes in
      FileHandle.standardOutput.write(Data(bytes))
    }
  }
}

private func parseWindowID() throws -> CGWindowID {
  guard
    let flagIndex = CommandLine.arguments.firstIndex(of: "--window-id"),
    CommandLine.arguments.indices.contains(flagIndex + 1),
    let rawWindowID = UInt32(CommandLine.arguments[flagIndex + 1]),
    rawWindowID > 0
  else {
    throw CaptureFailure.invalidArguments
  }
  return CGWindowID(rawWindowID)
}

private func waitForParentToCloseInput() async {
  await withCheckedContinuation { continuation in
    DispatchQueue.global(qos: .utility).async {
      var byte: UInt8 = 0
      while read(STDIN_FILENO, &byte, 1) > 0 {}
      continuation.resume()
    }
  }
}

@main
private struct MeetingApplicationAudioCapture {
  static func main() async {
    do {
      _ = NSApplication.shared
      let windowID = try parseWindowID()
      let content = try await SCShareableContent.excludingDesktopWindows(
        false,
        onScreenWindowsOnly: false
      )
      guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
        throw CaptureFailure.sourceWindowUnavailable(windowID)
      }

      // ScreenCaptureKit filters audio at application granularity. Selecting one meeting
      // window therefore captures all audio produced by that meeting application while
      // excluding AIRI and every unrelated process from the ASR input.
      let filter = SCContentFilter(desktopIndependentWindow: window)
      let configuration = SCStreamConfiguration()
      configuration.capturesAudio = true
      configuration.excludesCurrentProcessAudio = true
      configuration.sampleRate = 48_000
      configuration.channelCount = 2
      configuration.width = 2
      configuration.height = 2
      configuration.showsCursor = false

      let output = ApplicationAudioOutput()
      let stream = SCStream(filter: filter, configuration: configuration, delegate: output)
      output.onFailure = { error in
        writeDiagnostic(event: "error", message: error.localizedDescription)
        exit(EXIT_FAILURE)
      }
      try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: output.queue)
      try await stream.startCapture()
      writeDiagnostic(event: "ready")

      // Electron keeps stdin open for the session lifetime. EOF is the ownership signal that
      // guarantees a helper cannot survive its parent session or feed a later meeting.
      await waitForParentToCloseInput()
      try await stream.stopCapture()
      writeDiagnostic(event: "stopped")
    }
    catch {
      writeDiagnostic(event: "error", message: error.localizedDescription)
      exit(EXIT_FAILURE)
    }
  }
}
