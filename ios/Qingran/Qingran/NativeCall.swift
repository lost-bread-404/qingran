import AVFoundation
import Foundation
import UIKit
import UserNotifications
import WebKit

/// Owns the mic, a simple energy VAD, STT, /api/talk, and playback while CallKit is up.
final class NativePipeline {
  static let shared = NativePipeline()

  private let queue = DispatchQueue(label: "qingran.native-call")
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private var converter: AVAudioConverter?
  private var playerFormat: AVAudioFormat?
  private var playerAttached = false
  private var running = false
  private var stopping = false
  private var speaking = false
  private var inSpeech = false
  private var speechMs = 0
  private var silenceMs = 0
  private var speechPeak: Float = 0
  private var spikeMs = 0
  private var noiseFloor: Float = 0.008
  private var speech: [Int16] = []
  private var busy = false
  private var failures = 0
  private var playing = false
  private var emit: (([String: Any]) -> Void)?

  private init() {}

  var onHangup: (() -> Void)?

  func prepare(emit: @escaping ([String: Any]) -> Void) {
    self.emit = emit
    failures = 0
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
  }

  func permissionDenied() {
    emit?(["type": "error", "text": "麦克风没开。"])
    emitHangup()
  }

  func startEngine() {
    queue.async { [weak self] in
      self?.startEngineOnQueue()
    }
  }

  func stop() {
    queue.sync {
      haltLocked()
    }
  }

  private func startEngineOnQueue() {
    if running { return }
    let input = engine.inputNode
    let inFormat = input.inputFormat(forBus: 0)
    guard inFormat.sampleRate > 0,
          let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(NativeVad.sampleRate), channels: 1, interleaved: false),
          let conv = AVAudioConverter(from: inFormat, to: outFormat) else {
      note(ok: false, error: "audio-format")
      dropAfter(failures: 3)
      return
    }
    converter = conv
    if !playerAttached {
      engine.attach(player)
      engine.connect(player, to: engine.mainMixerNode, format: nil)
      playerAttached = true
    }
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { [weak self] buffer, _ in
      self?.take(buffer)
    }
    do {
      engine.prepare()
      try engine.start()
      playerFormat = player.outputFormat(forBus: 0)
      player.play()
      running = true
      emit?(["type": "phase", "phase": "listening"])
    } catch {
      note(ok: false, error: "engine \(error.localizedDescription)")
      dropAfter(failures: 3)
    }
  }

  private func haltLocked() {
    if stopping { return }
    stopping = true
    defer { stopping = false }
    running = false
    busy = false
    inSpeech = false
    speechPeak = 0
    speech.removeAll()
    playing = false
    engine.inputNode.removeTap(onBus: 0)
    player.stop()
    engine.stop()
  }

  private func take(_ buffer: AVAudioPCMBuffer) {
    guard running, let conv = converter,
          let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(NativeVad.sampleRate), channels: 1, interleaved: false) else { return }
    let ratio = outFormat.sampleRate / buffer.format.sampleRate
    let cap = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: max(cap, 32)),
          let samples = out.int16ChannelData else { return }
    var consumed = false
    var error: NSError?
    conv.convert(to: out, error: &error) { _, status in
      if consumed {
        status.pointee = .noDataNow
        return nil
      }
      consumed = true
      status.pointee = .haveData
      return buffer
    }
    if error != nil || out.frameLength == 0 { return }
    let n = Int(out.frameLength)
    var copy = [Int16](repeating: 0, count: n)
    for i in 0..<n { copy[i] = samples[0][i] }
    queue.async { [weak self] in
      self?.feed(copy)
    }
  }

  private func feed(_ samples: [Int16]) {
    guard running, !samples.isEmpty else { return }
    var sum: Float = 0
    for s in samples {
      let x = Float(s) / 32768
      sum += x * x
    }
    let rms = sqrt(sum / Float(samples.count))
    let chunkMs = max(1, samples.count * 1000 / NativeVad.sampleRate)
    if !inSpeech && !playing {
      noiseFloor = min(NativeVad.noiseFloorCap, noiseFloor * 0.95 + rms * 0.05)
    }
    let start = max(NativeVad.startFloorMin, noiseFloor * NativeVad.startFloorMult)
    if playing && rms >= start {
      spikeMs += chunkMs
      if spikeMs >= NativeVad.spikeMs {
        interruptPlayback()
      }
    } else {
      spikeMs = 0
    }
    if busy || playing { return }
    if !inSpeech {
      if rms >= start {
        inSpeech = true
        speechMs = 0
        silenceMs = 0
        speechPeak = 0
        speech.removeAll(keepingCapacity: true)
        emit?(["type": "phase", "phase": "speaking-you"])
      } else {
        return
      }
    }
    speech.append(contentsOf: samples)
    speechMs += chunkMs
    let bar = max(start, speechPeak * NativeVad.endLiveRatio)
    if rms >= bar {
      speechPeak = followPeak(speechPeak, rms, chunkMs)
      silenceMs = 0
    } else {
      silenceMs += chunkMs
    }
    if speechMs >= NativeVad.maxUtteranceMs || (speechMs >= NativeVad.minSpeechMs && silenceMs >= NativeVad.silenceMs) {
      let said = speech
      inSpeech = false
      speech.removeAll(keepingCapacity: true)
      speechMs = 0
      silenceMs = 0
      speechPeak = 0
      busy = true
      Task { await self.utter(said) }
    }
  }

  private func followPeak(_ prev: Float, _ rms: Float, _ chunkMs: Int) -> Float {
    let dt = Float(max(0, chunkMs))
    if prev <= 0 {
      let k = 1 - pow(0.5, dt / NativeVad.peakAttackMs)
      return rms * k
    }
    if rms >= prev {
      let k = 1 - pow(0.5, dt / NativeVad.peakAttackMs)
      return prev + (rms - prev) * k
    }
    return max(rms, prev * pow(0.5, dt / NativeVad.peakReleaseMs))
  }

  private func interruptPlayback() {
    playing = false
    spikeMs = 0
    player.stop()
    player.play()
  }

  private func utter(_ samples: [Int16]) async {
    guard running else {
      queue.async { self.busy = false }
      return
    }
    emit?(["type": "phase", "phase": "transcribing"])
    defer {
      queue.async {
        self.busy = false
        if self.running && !self.playing { self.emit?(["type": "phase", "phase": "listening"]) }
      }
    }
    let wav = wavData(samples)
    guard let text = await transcribe(wav) else {
      softFail("stt")
      return
    }
    if text.isEmpty { return }
    let userId = UUID().uuidString.lowercased()
    let replyId = UUID().uuidString.lowercased()
    let now = Int(Date().timeIntervalSince1970 * 1000)
    emit?(["type": "heard", "id": userId, "text": text, "at": now])
    await talk(text: text, userId: userId, replyId: replyId, now: now)
  }

  private func transcribe(_ wav: Data) async -> String? {
    guard let url = endpoint("api/stt") else { return nil }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue(await cookieHeader(), forHTTPHeaderField: "Cookie")
    let body: [String: Any] = ["audioBase64": wav.base64EncodedString(), "mimeType": "audio/wav"]
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    do {
      let (data, res) = try await URLSession.shared.data(for: req)
      let code = (res as? HTTPURLResponse)?.statusCode ?? 0
      guard code == 200,
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            json["ok"] as? Bool == true,
            let text = json["text"] as? String else {
        note(ok: false, error: "stt \(code)")
        return nil
      }
      return text.trimmingCharacters(in: .whitespacesAndNewlines)
    } catch {
      note(ok: false, error: "stt \(error.localizedDescription)")
      return nil
    }
  }

  private func talk(text: String, userId: String, replyId: String, now: Int) async {
    guard let url = endpoint("api/talk") else {
      softFail("talk-url")
      return
    }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    req.setValue(await cookieHeader(), forHTTPHeaderField: "Cookie")
    let zone = TimeZone.current.identifier
    let body: [String: Any] = [
      "text": text,
      "userMsgId": userId,
      "userCreatedAt": now,
      "replyId": replyId,
      "timeZone": zone,
      "nowMs": now,
    ]
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    do {
      let (bytes, res) = try await URLSession.shared.bytes(for: req)
      let code = (res as? HTTPURLResponse)?.statusCode ?? 0
      guard code == 200 else {
        softFail("talk \(code)")
        return
      }
      var buf = Data()
      var speech = ""
      let sep = Data([10, 10])
      for try await byte in bytes {
        buf.append(byte)
        guard let range = buf.range(of: sep) else { continue }
        let frame = buf.subdata(in: 0..<range.lowerBound)
        buf.removeSubrange(0..<range.upperBound)
        guard let event = sseJSON(frame) else { continue }
          let kind = event["t"] as? String ?? ""
          if kind == "text", let delta = event["d"] as? String {
            speech += delta
            emit?(["type": "reply", "id": replyId, "text": speech, "replyTo": userId])
          } else if kind == "text_end", let full = event["speech"] as? String, !full.isEmpty {
            speech = full
            emit?(["type": "reply", "id": replyId, "text": speech, "replyTo": userId])
          } else if kind == "audio", let b64 = event["b"] as? String {
            let replace = event["replace"] as? Bool ?? false
            let mime = event["m"] as? String ?? ""
            queue.async { self.playPCM(b64, mime: mime, replace: replace) }
          } else if kind == "err" {
            softFail((event["m"] as? String) ?? "talk")
            return
          } else if kind == "done" {
            failures = 0
            if speech.isEmpty, let full = event["speech"] as? String {
              speech = full
              emit?(["type": "reply", "id": replyId, "text": speech, "replyTo": userId])
            }
          }
        }
    } catch {
      softFail("talk \(error.localizedDescription)")
    }
  }

  private func playPCM(_ b64: String, mime: String, replace: Bool) {
    guard running, let raw = Data(base64Encoded: b64), raw.count >= 2, let fmt = playerFormat, fmt.sampleRate > 0 else { return }
    let rate = mime.range(of: "rate=").flatMap { rest -> Double? in
      let tail = mime[rest.upperBound...]
      let digits = tail.prefix { $0.isNumber }
      return Double(digits)
    } ?? 24000
    let frames = raw.count / 2
    guard let srcFmt = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: false),
          let src = AVAudioPCMBuffer(pcmFormat: srcFmt, frameCapacity: AVAudioFrameCount(frames)),
          let dst = src.int16ChannelData else { return }
    src.frameLength = AVAudioFrameCount(frames)
    let bytes = [UInt8](raw)
    for i in 0..<frames {
      let lo = UInt16(bytes[i * 2])
      let hi = UInt16(bytes[i * 2 + 1])
      dst[0][i] = Int16(bitPattern: lo | (hi << 8))
    }
    guard let converted = convert(src, to: fmt) else { return }
    if replace {
      player.stop()
      player.play()
    }
    playing = true
    player.scheduleBuffer(converted, completionHandler: { [weak self] in
      self?.queue.async {
        guard let self else { return }
        if !self.player.isPlaying { self.playing = false }
      }
    })
    if !player.isPlaying { player.play() }
  }

  private func convert(_ buffer: AVAudioPCMBuffer, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
    guard let conv = AVAudioConverter(from: buffer.format, to: format) else { return nil }
    let ratio = format.sampleRate / buffer.format.sampleRate
    let cap = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: max(cap, 32)) else { return nil }
    var consumed = false
    var error: NSError?
    conv.convert(to: out, error: &error) { _, status in
      if consumed {
        status.pointee = .noDataNow
        return nil
      }
      consumed = true
      status.pointee = .haveData
      return buffer
    }
    if error != nil || out.frameLength == 0 { return nil }
    return out
  }

  private func softFail(_ why: String) {
    note(ok: false, error: why)
    failures += 1
    queue.async { self.playTone() }
    if failures >= 3 { dropAfter(failures: failures) }
  }

  private func dropAfter(failures n: Int) {
    guard n >= 3 else { return }
    let content = UNMutableNotificationContent()
    content.title = "清然"
    content.body = "通话断了"
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    DispatchQueue.main.async {
      CallEngine.shared.endCallFromWeb()
      self.emitHangup()
    }
  }

  private func playTone() {
    guard running, let fmt = playerFormat, fmt.sampleRate > 0, let dst = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(fmt.sampleRate * 0.18)) else { return }
    dst.frameLength = dst.frameCapacity
    let channels = Int(fmt.channelCount)
    let n = Int(dst.frameLength)
    let rate = Float(fmt.sampleRate)
    if let floats = dst.floatChannelData {
      for c in 0..<channels {
        for i in 0..<n {
          let env = 1 - Float(i) / Float(max(n, 1))
          floats[c][i] = sin(2 * .pi * 880 * Float(i) / rate) * 0.12 * env
        }
      }
    }
    playing = true
    player.scheduleBuffer(dst, completionHandler: { [weak self] in
      self?.queue.async {
        guard let self else { return }
        if !self.player.isPlaying { self.playing = false }
      }
    })
    if !player.isPlaying { player.play() }
  }

  private func emitHangup() {
    emit?(["type": "ended"])
    let hangup = onHangup
    DispatchQueue.main.async {
      hangup?()
    }
  }

  private func note(ok: Bool, error: String) {
    Task {
      guard let url = self.endpoint("api/native-log") else { return }
      var req = URLRequest(url: url)
      req.httpMethod = "POST"
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.setValue(await self.cookieHeader(), forHTTPHeaderField: "Cookie")
      let body: [String: Any] = ["ok": ok, "error": String(error.prefix(500)), "note": "native-call"]
      req.httpBody = try? JSONSerialization.data(withJSONObject: body)
      _ = try? await URLSession.shared.data(for: req)
    }
  }

  private func endpoint(_ path: String) -> URL? {
    guard let base = QingranConfig.savedURL,
          var parts = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
    parts.path = path.hasPrefix("/") ? path : "/" + path
    parts.query = nil
    parts.fragment = nil
    return parts.url
  }

  private func cookieHeader() async -> String {
    await withCheckedContinuation { cont in
      DispatchQueue.main.async {
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
          let header = cookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
          cont.resume(returning: header)
        }
      }
    }
  }

  private func sseJSON(_ frame: Data) -> [String: Any]? {
    guard let text = String(data: frame, encoding: .utf8) else { return nil }
    let line = text.split(separator: "\n").first { $0.hasPrefix("data:") }
    guard let line else { return nil }
    let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
    guard let data = payload.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return json
  }

  private func wavData(_ samples: [Int16]) -> Data {
    let dataSize = samples.count * 2
    var data = Data()
    data.reserveCapacity(44 + dataSize)
    func append(_ text: String) { data.append(contentsOf: text.utf8) }
    func u32(_ v: UInt32) { var x = v.littleEndian; withUnsafeBytes(of: &x) { data.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { var x = v.littleEndian; withUnsafeBytes(of: &x) { data.append(contentsOf: $0) } }
    append("RIFF")
    u32(UInt32(36 + dataSize))
    append("WAVE")
    append("fmt ")
    u32(16)
    u16(1)
    u16(1)
    u32(UInt32(NativeVad.sampleRate))
    u32(UInt32(NativeVad.sampleRate * 2))
    u16(2)
    u16(16)
    append("data")
    u32(UInt32(dataSize))
    samples.withUnsafeBytes { data.append(contentsOf: $0) }
    return data
  }
}
