import AVFoundation
import Foundation
import WebKit

/// How to stream her voice to xAI (from /api/stt-stream): the address with her words to listen for and her pause, and
/// a secret that lasts a few minutes, so the phone never holds a real key.
struct StreamTicket {
  let url: URL
  let token: String
  let expiresAt: Date

  init?(_ json: [String: Any]) {
    guard json["ok"] as? Bool == true,
          let raw = json["url"] as? String, let url = URL(string: raw),
          let token = json["token"] as? String, !token.isEmpty else { return nil }
    self.url = url
    self.token = token
    let at = (json["expiresAt"] as? NSNumber)?.doubleValue ?? 0
    expiresAt = at > 0 ? Date(timeIntervalSince1970: at / 1000) : Date().addingTimeInterval(240)
  }

  /// Still good for a while.
  var fresh: Bool { expiresAt.timeIntervalSinceNow > 90 }
}

/// Her words as shown and sent (the same rules as src/lib/lover/ear.ts and voice/ear-client.ts).
enum Heard {
  /// Pieces of a line run together; a space only between two Latin words.
  static func join(_ a: String, _ b: String) -> String {
    if a.isEmpty { return b }
    if b.isEmpty { return a }
    if let x = a.unicodeScalars.last, let y = b.unicodeScalars.first, latin(x), latin(y) { return a + " " + b }
    return a + b
  }

  private static func latin(_ c: Unicode.Scalar) -> Bool {
    (0x30...0x39).contains(c.value) || (0x41...0x5A).contains(c.value) || (0x61...0x7A).contains(c.value)
  }

  private static let marks: Set<Character> = [" ", "，", "。", "！", "？", "、", ",", ".", "!", "?", "…", "～"]

  /// xAI's own ~ shown as ～, and a line the recognizer wrote twice in a row kept once (only a long one counts).
  static func tidy(_ raw: String) -> String {
    var text = raw.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
    text = text.replacingOccurrences(of: "~+", with: "～", options: .regularExpression)
    let chars = Array(text)
    let core = chars.filter { !marks.contains($0) }
    guard core.count >= 12, core.count % 2 == 0 else { return text }
    let half = core.count / 2
    guard Array(core[0..<half]) == Array(core[half...]) else { return text }
    var seen = 0
    for i in chars.indices {
      if !marks.contains(chars[i]) { seen += 1 }
      if seen == half {
        var end = i + 1
        while end < chars.count && marks.contains(chars[end]) && chars[end] != " " { end += 1 }
        return String(chars[0..<end])
      }
    }
    return text
  }
}

/**
 * xAI's recognizer over a WebSocket, as the page's src/lib/lover/voice/ear-client.ts. Her audio waits until xAI says
 * the stream is ready (transcript.created), then goes up as it comes. Everything here, hooks included, runs on the
 * `queue` it is given (the voice's), so it needs no locks.
 */
final class Ear: @unchecked Sendable {
  enum Mode { case hold, call }

  /// Seconds of her voice sent (what xAI bills).
  private(set) var sent: Double = 0
  /// When xAI last heard a word.
  private(set) var wordsAt = Date()
  let born = Date()
  /// When its ticket runs out (the stream may stop then).
  private(set) var expiresAt: Date?
  /// What she is saying so far (holding: everything since the press; a call: the line in progress, empty once done).
  var onText: ((String) -> Void)?
  /// A call: she finished this line.
  var onLine: ((String) -> Void)?
  /// The stream stopped working before it was finished.
  var onDead: ((String) -> Void)?

  private let mode: Mode
  private let queue: DispatchQueue
  private var socket: URLSessionWebSocketTask?
  private var ready = false
  private var closed = false
  private var dead = false
  private var waiting: [Data] = []
  private var line = ""
  private var whole = ""
  private var finishing: ((String?) -> Void)?
  private var finishGen = 0

  init(mode: Mode, queue: DispatchQueue) {
    self.mode = mode
    self.queue = queue
  }

  /// Up and listening.
  var live: Bool { ready && !dead && !closed }

  /// With a ticket in hand it connects at once; otherwise one is fetched first (her audio waits meanwhile).
  func open(_ ticket: StreamTicket?, fetch: @escaping () async -> StreamTicket?) {
    if let ticket {
      connect(ticket)
    } else {
      Task {
        let got = await fetch()
        self.queue.async {
          guard !self.closed, !self.dead else { return }
          if let got { self.connect(got) } else { self.die("no ticket") }
        }
      }
    }
    queue.asyncAfter(deadline: .now() + 8) { [weak self] in
      guard let self, !self.ready else { return }
      self.die("not ready in time")
    }
  }

  /// 100 ms of her voice (16 kHz, 16-bit). Kept until the stream is ready.
  func send(_ pcm: [Int16]) {
    guard !closed, !dead, !pcm.isEmpty else { return }
    let data = pcm.withUnsafeBufferPointer { Data(buffer: $0) }
    guard ready else {
      waiting.append(data)
      if waiting.count > 600 { waiting.removeFirst() }
      return
    }
    push(data)
  }

  /// She is done: the rest is heard and the whole text comes back; nil when the stream did not finish (never opened,
  /// broke, or too slow), and the caller reads the audio whole instead.
  func finish(timeout: TimeInterval = 3, _ done: @escaping (String?) -> Void) {
    guard !closed, !dead else {
      done(nil)
      return
    }
    finishing = done
    finishGen += 1
    let gen = finishGen
    queue.asyncAfter(deadline: .now() + timeout) { [weak self] in
      guard let self, self.finishGen == gen else { return }
      self.settle(nil)
    }
    if ready { sendDone() }
  }

  /// Dropped (cancelled, hung up, or finished): nothing more is heard or reported.
  func close() {
    guard !closed else { return }
    closed = true
    settle(nil)
    waiting.removeAll()
    socket?.cancel(with: .goingAway, reason: nil)
  }

  private func connect(_ ticket: StreamTicket) {
    expiresAt = ticket.expiresAt
    var req = URLRequest(url: ticket.url)
    req.setValue("Bearer \(ticket.token)", forHTTPHeaderField: "Authorization")
    let task = URLSession.shared.webSocketTask(with: req)
    socket = task
    task.resume()
    receive(task)
  }

  private func push(_ data: Data) {
    socket?.send(.data(data)) { _ in }
    sent += Double(data.count / 2) / 16_000
  }

  private func sendDone() {
    socket?.send(.string("{\"type\":\"audio.done\"}")) { _ in }
  }

  private func receive(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .failure(let error):
        self.queue.async {
          let code = (task.response as? HTTPURLResponse)?.statusCode ?? 0
          self.die(code > 0 ? "stream \(code)" : "stream \(error.localizedDescription)")
        }
      case .success(let message):
        if case .string(let text) = message {
          self.queue.async { self.handle(text) }
        }
        self.receive(task)
      }
    }
  }

  private func shown(_ guess: String) -> String {
    Heard.tidy(Heard.join(mode == .hold ? whole : line, guess))
  }

  private func handle(_ text: String) {
    guard !closed,
          let data = text.data(using: .utf8),
          let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
    switch event["type"] as? String ?? "" {
    case "transcript.created":
      ready = true
      let queued = waiting
      waiting.removeAll()
      for chunk in queued { push(chunk) }
      if finishing != nil { sendDone() }
    case "transcript.partial":
      let piece = (event["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      if !piece.isEmpty { wordsAt = Date() }
      guard event["is_final"] as? Bool == true else {
        onText?(shown(piece))
        return
      }
      if !piece.isEmpty {
        line = Heard.join(line, piece)
        whole = Heard.join(whole, piece)
      }
      if event["speech_final"] as? Bool == true && mode == .call {
        // The line first, then that she is no longer saying one.
        let said = Heard.tidy(line)
        line = ""
        if !said.isEmpty { onLine?(said) }
        onText?("")
        return
      }
      onText?(shown(""))
    case "transcript.done":
      let done = (event["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      if mode == .call {
        // A line still open when the stream ends is still a line.
        let open = Heard.tidy(line)
        line = ""
        if !open.isEmpty {
          onLine?(open)
          onText?("")
        }
      }
      // The longer of the two: the final text, or every piece locked on the way (in case either is cut short).
      settle(Heard.tidy(done.count >= whole.count ? done : whole))
      close()
    case "error":
      die("stream \(event["message"] as? String ?? "error")")
    default:
      break
    }
  }

  private func settle(_ text: String?) {
    guard let done = finishing else { return }
    finishing = nil
    finishGen += 1
    done(text)
  }

  private func die(_ why: String) {
    guard !closed, !dead else { return }
    dead = true
    settle(nil)
    onDead?(why)
    socket?.cancel(with: .goingAway, reason: nil)
  }
}

/**
 * Her mic as xAI wants it: 16 kHz, 16-bit mono, in frames of 100 ms, lifted ×4 (the phone's mic hears her several
 * times softer than a browser, which raises the level itself) under a soft ceiling, so a soft 嗯 is not lost. Its own
 * engine, on only while she holds to talk or is in a call (the orange dot shows exactly then).
 */
final class Mic: @unchecked Sendable {
  static let rate: Double = 16_000
  static let frame = 1600
  static let lift: Float = 4

  /// Every 100 ms frame, with how loud it is (lifted). Called on the audio thread.
  var onFrame: (([Int16], Float) -> Void)?
  private(set) var running = false
  private let engine = AVAudioEngine()
  private var converter: AVAudioConverter?
  private var pending: [Int16] = []
  private let lock = NSLock()

  var engineRunning: Bool { engine.isRunning }

  func start() throws {
    if running && engine.isRunning { return }
    if running { stop() }
    let input = engine.inputNode
    let inFormat = input.inputFormat(forBus: 0)
    guard inFormat.sampleRate > 0, inFormat.channelCount > 0,
          let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Mic.rate, channels: 1, interleaved: false),
          let conv = AVAudioConverter(from: inFormat, to: outFormat) else {
      throw NSError(domain: "qingran.mic", code: 1, userInfo: [NSLocalizedDescriptionKey: "麦克风打不开"])
    }
    converter = conv
    lock.lock()
    pending.removeAll()
    lock.unlock()
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { [weak self] buffer, _ in
      self?.take(buffer, as: outFormat)
    }
    engine.prepare()
    try engine.start()
    running = true
  }

  /// Off. What is left of the last frame stays for `flush`.
  func stop() {
    guard running else { return }
    running = false
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
  }

  /// The part of a frame not yet handed on (at most 100 ms).
  func flush() -> [Int16] {
    lock.lock()
    defer { lock.unlock() }
    let rest = pending
    pending.removeAll()
    return rest
  }

  private func take(_ buffer: AVAudioPCMBuffer, as outFormat: AVAudioFormat) {
    guard let conv = converter, buffer.format.sampleRate > 0 else { return }
    let ratio = outFormat.sampleRate / buffer.format.sampleRate
    let cap = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: max(cap, 32)) else { return }
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
    guard error == nil, out.frameLength > 0, let samples = out.int16ChannelData else { return }
    let n = Int(out.frameLength)
    var frames: [[Int16]] = []
    lock.lock()
    for i in 0..<n {
      let x = Float(samples[0][i]) / 32768
      pending.append(Int16((Mic.limit(x * Mic.lift) * 32767).rounded()))
      if pending.count == Mic.frame {
        frames.append(pending)
        pending.removeAll(keepingCapacity: true)
      }
    }
    lock.unlock()
    for frame in frames { onFrame?(frame, Mic.rms(frame)) }
  }

  /// Soft ceiling for the lifted voice: untouched up to 0.7, then bent toward 1, never clipped.
  static func limit(_ x: Float) -> Float {
    let a = abs(x)
    if a <= 0.7 { return x }
    return (x < 0 ? -1 : 1) * (0.7 + 0.3 * tanh((a - 0.7) / 0.3))
  }

  static func rms(_ frame: [Int16]) -> Float {
    guard !frame.isEmpty else { return 0 }
    var sum: Float = 0
    for s in frame {
      let x = Float(s) / 32768
      sum += x * x
    }
    return sqrt(sum / Float(frame.count))
  }
}

/// The site the shell opened, and how it talks to it.
enum Net {
  static func endpoint(_ path: String, query: String? = nil) -> URL? {
    guard let base = QingranConfig.savedURL,
          var parts = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
    parts.path = path.hasPrefix("/") ? path : "/" + path
    parts.query = query
    parts.fragment = nil
    return parts.url
  }

  /// The page's login, so the shell's requests pass the password gate.
  static func cookieHeader() async -> String {
    await withCheckedContinuation { cont in
      DispatchQueue.main.async {
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
          cont.resume(returning: cookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; "))
        }
      }
    }
  }

  /// A connection iOS dropped while the app changed state fails once with "connection lost"; the same request again
  /// goes through.
  static func send(_ req: URLRequest) async throws -> (Data, URLResponse) {
    do {
      return try await URLSession.shared.data(for: req)
    } catch let error as URLError where error.code == .networkConnectionLost || error.code == .notConnectedToInternet {
      try await Task.sleep(nanoseconds: 400_000_000)
      return try await URLSession.shared.data(for: req)
    }
  }

  static func stream(_ req: URLRequest) async throws -> (URLSession.AsyncBytes, URLResponse) {
    do {
      return try await URLSession.shared.bytes(for: req)
    } catch let error as URLError where error.code == .networkConnectionLost || error.code == .notConnectedToInternet {
      try await Task.sleep(nanoseconds: 400_000_000)
      return try await URLSession.shared.bytes(for: req)
    }
  }

  /// One server-sent event's JSON.
  static func sse(_ frame: Data) -> [String: Any]? {
    guard let text = String(data: frame, encoding: .utf8),
          let line = text.split(separator: "\n").first(where: { $0.hasPrefix("data:") }),
          let data = line.dropFirst(5).trimmingCharacters(in: .whitespaces).data(using: .utf8) else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  }

  /// 16-bit mono WAV.
  static func wav(_ samples: [Int16], rate: Int) -> Data {
    let size = samples.count * 2
    var data = Data()
    data.reserveCapacity(44 + size)
    func ascii(_ text: String) { data.append(contentsOf: text.utf8) }
    func u32(_ v: UInt32) { var x = v.littleEndian; withUnsafeBytes(of: &x) { data.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { var x = v.littleEndian; withUnsafeBytes(of: &x) { data.append(contentsOf: $0) } }
    ascii("RIFF")
    u32(UInt32(36 + size))
    ascii("WAVE")
    ascii("fmt ")
    u32(16)
    u16(1)
    u16(1)
    u32(UInt32(rate))
    u32(UInt32(rate * 2))
    u16(2)
    u16(16)
    ascii("data")
    u32(UInt32(size))
    samples.withUnsafeBytes { data.append(contentsOf: $0) }
    return data
  }
}
