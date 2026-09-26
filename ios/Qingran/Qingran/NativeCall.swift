import AVFoundation
import Foundation
import UIKit
import UserNotifications
import WebKit

/// Owns every call inside the shell, like WeChat: mic, the same VAD as the web
/// (src/lib/lover/vad.ts), hearing through /api/stt (the web's hearing pipeline on
/// the server), /api/talk, and playback. Keeps going with the app in the background.
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
  private var params = NativeVadParams()

  // VAD
  private var level: Float = 0
  private var floor: Float = NativeVad.floorStart
  private var riseMs: Float = 0
  private var preroll: [Int16] = []
  private var inSpeech = false
  private var speech: [Int16] = []
  private var speechMs: Float = 0
  private var quietMs: Float = 0
  private var speechStartAt = 0
  private var triggerFloor: Float = 0

  // Turn and playback
  private var busy = false
  private var turnGen = 0
  private var talkTask: Task<Void, Never>?
  private var pendingBuffers = 0
  /// Bumped whenever scheduled audio is thrown away, so late completion callbacks are ignored.
  private var playGen = 0
  private var playing: Bool { pendingBuffers > 0 }
  private var playIdleAt = Date.distantPast
  private var bargeMs: Float = 0
  private var failures = 0
  private var emit: (([String: Any]) -> Void)?

  private init() {}

  var onHangup: (() -> Void)?

  func prepare(params raw: [String: Any]?, emit: @escaping ([String: Any]) -> Void) {
    let next = NativeVadParams(raw)
    queue.sync { self.params = next }
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
      level = 0
      floor = NativeVad.floorStart
      riseMs = 0
      preroll.removeAll()
      playIdleAt = Date()
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
    turnGen += 1
    talkTask?.cancel()
    talkTask = nil
    busy = false
    inSpeech = false
    riseMs = 0
    bargeMs = 0
    dropPlayback()
    preroll.removeAll()
    speech.removeAll()
    engine.inputNode.removeTap(onBus: 0)
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

  /// Same steps as the tick in src/hooks/use-call.ts.
  private func feed(_ samples: [Int16]) {
    guard running, !samples.isEmpty else { return }
    var sum: Float = 0
    for s in samples {
      let x = Float(s) / 32768
      sum += x * x
    }
    let rms = sqrt(sum / Float(samples.count))
    let chunkMs = Float(samples.count) * 1000 / Float(NativeVad.sampleRate)

    level += (rms - level) * (1 - exp(-chunkMs / NativeVad.levelMs))
    if !playing && Float(Date().timeIntervalSince(playIdleAt) * 1000) >= NativeVad.postPlaybackMs {
      floor = nextFloor(floor, level, chunkMs, inTurn: inSpeech)
    }

    let keep = NativeVad.sampleRate * NativeVad.preRollMs / 1000
    preroll.append(contentsOf: samples)
    if preroll.count > keep { preroll.removeFirst(preroll.count - keep) }

    if playing {
      if level >= max(NativeVad.bargeMin, floor * NativeVad.bargeMult) {
        bargeMs += chunkMs
        if bargeMs >= NativeVad.bargeHoldMs { interruptReply() }
      } else {
        bargeMs = 0
      }
    }
    if busy || playing {
      riseMs = 0
      return
    }

    if !inSpeech {
      if level >= max(params.startMin, floor * params.startMult) {
        riseMs += chunkMs
        if riseMs < params.startHoldMs { return }
        inSpeech = true
        riseMs = 0
        speech = preroll
        speechMs = 0
        quietMs = 0
        triggerFloor = floor
        speechStartAt = Int(Date().timeIntervalSince1970 * 1000)
        emit?(["type": "phase", "phase": "speaking-you"])
      } else {
        riseMs = 0
      }
      return
    }

    speech.append(contentsOf: samples)
    speechMs += chunkMs
    if level >= max(params.holdMin, floor * params.holdMult) {
      quietMs = 0
    } else {
      quietMs += chunkMs
    }
    let capped = speechMs >= params.maxUtteranceMs
    let ended = speechMs >= NativeVad.minSpeechMs && quietMs >= params.endWaitMs
    if capped || ended {
      let said = speech
      let silenceWait = Int(quietMs)
      inSpeech = false
      speech.removeAll(keepingCapacity: true)
      preroll.removeAll(keepingCapacity: true)
      speechMs = 0
      quietMs = 0
      busy = true
      turnGen += 1
      let gen = turnGen
      let start = speechStartAt
      let vadFloor = triggerFloor
      talkTask = Task { await self.utter(said, gen: gen, speechStart: start, silenceWaitMs: silenceWait, vadFloor: vadFloor) }
    }
  }

  private func nextFloor(_ floor: Float, _ level: Float, _ dtMs: Float, inTurn: Bool) -> Float {
    let f = floor > 0 ? floor : NativeVad.floorStart
    let rise = inTurn ? NativeVad.floorRiseMs : NativeVad.floorRiseIdleMs
    let next: Float
    if level <= f {
      next = f + (level - f) * (1 - exp(-dtMs / NativeVad.floorFallMs))
    } else {
      next = min(level, f * exp(dtMs / rise))
    }
    return min(NativeVad.floorMax, max(NativeVad.floorMin, next))
  }

  /// She talked over Qingran: stop his voice and the rest of that reply, and listen.
  private func interruptReply() {
    turnGen += 1
    talkTask?.cancel()
    talkTask = nil
    busy = false
    bargeMs = 0
    dropPlayback()
    player.play()
    emit?(["type": "phase", "phase": "listening"])
  }

  private func dropPlayback() {
    playGen += 1
    pendingBuffers = 0
    playIdleAt = Date()
    player.stop()
  }

  private func current(_ gen: Int) -> Bool {
    queue.sync { self.running && self.turnGen == gen }
  }

  private func utter(_ samples: [Int16], gen: Int, speechStart: Int, silenceWaitMs: Int, vadFloor: Float) async {
    emit?(["type": "phase", "phase": "transcribing"])
    defer {
      queue.async {
        guard self.turnGen == gen else { return }
        self.busy = false
        self.talkTask = nil
        if self.running && !self.playing { self.emit?(["type": "phase", "phase": "listening"]) }
      }
    }
    let wav = wavData(samples)
    let endpointFired = Int(Date().timeIntervalSince1970 * 1000)
    guard let text = await transcribe(wav, speechStart: speechStart, endpointFired: endpointFired, silenceWaitMs: silenceWaitMs, vadFloor: vadFloor) else {
      if current(gen) { softFail("stt") }
      return
    }
    if text.isEmpty || !current(gen) { return }
    let userId = UUID().uuidString.lowercased()
    let replyId = UUID().uuidString.lowercased()
    let now = Int(Date().timeIntervalSince1970 * 1000)
    emit?(["type": "heard", "id": userId, "text": text, "at": now])
    await talk(text: text, userId: userId, replyId: replyId, now: now, gen: gen)
  }

  private func transcribe(_ wav: Data, speechStart: Int, endpointFired: Int, silenceWaitMs: Int, vadFloor: Float) async -> String? {
    guard let url = endpoint("api/stt") else { return nil }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue(await cookieHeader(), forHTTPHeaderField: "Cookie")
    let body: [String: Any] = [
      "audioBase64": wav.base64EncodedString(),
      "mimeType": "audio/wav",
      "speechStart": speechStart,
      "endpointFired": endpointFired,
      "silenceWaitMs": silenceWaitMs,
      "vadFloor": vadFloor,
    ]
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
      if Task.isCancelled { return nil }
      note(ok: false, error: "stt \(error.localizedDescription)")
      return nil
    }
  }

  private func talk(text: String, userId: String, replyId: String, now: Int, gen: Int) async {
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
        if Task.isCancelled { return }
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
          queue.async {
            guard self.turnGen == gen else { return }
            self.playPCM(b64, mime: mime, replace: replace)
          }
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
      if Task.isCancelled { return }
      softFail("talk \(error.localizedDescription)")
    }
  }

  private func schedule(_ buffer: AVAudioPCMBuffer) {
    let gen = playGen
    pendingBuffers += 1
    player.scheduleBuffer(buffer, completionHandler: { [weak self] in
      self?.queue.async {
        guard let self, self.playGen == gen, self.pendingBuffers > 0 else { return }
        self.pendingBuffers -= 1
        if self.pendingBuffers == 0 {
          self.playIdleAt = Date()
          self.bargeMs = 0
          if self.running && !self.busy { self.emit?(["type": "phase", "phase": "listening"]) }
        }
      }
    })
    if !player.isPlaying { player.play() }
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
      dropPlayback()
      player.play()
    }
    schedule(converted)
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
    schedule(dst)
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
