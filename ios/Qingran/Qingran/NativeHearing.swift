import AVFoundation
import Foundation
import Speech

/// How to stream one line of hers to xAI (from /api/stt-stream): the address with her keyterms, a secret that lasts
/// a few minutes, and how long a pause may be before the line ends however unfinished it sounds.
struct StreamTicket {
  let url: URL
  let token: String
  let expiresAt: Date
  let backstopMs: Float
  let quietMs: Float

  init?(_ json: [String: Any]) {
    guard json["ok"] as? Bool == true,
          let raw = json["url"] as? String, let url = URL(string: raw),
          let token = json["token"] as? String, !token.isEmpty else { return nil }
    self.url = url
    self.token = token
    let at = (json["expiresAt"] as? NSNumber)?.doubleValue ?? 0
    expiresAt = at > 0 ? Date(timeIntervalSince1970: at / 1000) : Date().addingTimeInterval(240)
    backstopMs = (json["backstopMs"] as? NSNumber)?.floatValue ?? 3000
    quietMs = (json["quietMs"] as? NSNumber)?.floatValue ?? 600
  }

  /// Still good for a whole line.
  var fresh: Bool { expiresAt.timeIntervalSinceNow > 90 }
}

/// What one line was heard as, while she said it. Nil = that ear did not work for this line.
struct LineHeard {
  var stream: (text: String, words: [[String: Any]])?
  var apple: String?

  /// She went on after a pause: the two parts are one line, and each ear's text is whole only if it heard both.
  func then(_ next: LineHeard) -> LineHeard {
    LineHeard(
      stream: stream.flatMap { a in next.stream.map { b in (text: a.text + b.text, words: a.words + b.words) } },
      apple: apple.flatMap { a in next.apple.map { a + $0 } }
    )
  }
}

/**
 * One line of hers, heard two ways while she says it, like the web call: streamed to xAI (which also says when the
 * sentence sounds finished) and given to Apple's recognizer. When she is done, `finish` waits a moment for both last
 * words. Anything that fails just leaves that ear out; the clip still goes to the server whole.
 */
final class LineHearing {
  private let queue = DispatchQueue(label: "qingran.line-hearing")
  private var socket: URLSessionWebSocketTask?
  private var waitingAudio: [Data] = []
  private var connecting = true
  private var streamFailed = false
  private var streamDone = false
  private var finals: [String] = []
  private var words: [[String: Any]] = []
  private var doneText: String?
  private var doneWords: [[String: Any]] = []

  private var appleRequest: SFSpeechAudioBufferRecognitionRequest?
  private var appleTask: SFSpeechRecognitionTask?
  private var appleText: String?
  private var appleDone = false
  private var appleFormat: AVAudioFormat?

  private var appleGrace = false
  private var finishing: CheckedContinuation<LineHeard, Never>?
  private var closed = false

  /// xAI's turn model says she has finished the sentence.
  var onFinished: (() -> Void)?
  /// The stream is live (xAI accepted it); until then the phone ends lines on its own pause rule.
  var onLive: (() -> Void)?
  /// Why the stream did not work, for the call log.
  var onTrouble: ((String) -> Void)?

  private static let recognizer: SFSpeechRecognizer? = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))

  static func askApple() {
    if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
      SFSpeechRecognizer.requestAuthorization { _ in }
    }
  }

  /// No ticket in hand → one is fetched now (her first words wait for it); no way to get one → not streamed.
  init(ticket: StreamTicket?, fetch: (() async -> StreamTicket?)?) {
    if let ticket {
      connect(ticket)
    } else if let fetch {
      Task {
        let got = await fetch()
        self.queue.async {
          guard !self.closed else { return }
          if let got {
            self.connect(got)
          } else {
            self.connecting = false
            self.streamFailed = true
            self.waitingAudio.removeAll()
            self.settle()
          }
        }
      }
    } else {
      connecting = false
      streamFailed = true
    }
    startApple()
  }

  private func connect(_ ticket: StreamTicket) {
    var req = URLRequest(url: ticket.url)
    req.setValue("Bearer \(ticket.token)", forHTTPHeaderField: "Authorization")
    let task = URLSession.shared.webSocketTask(with: req)
    socket = task
    task.resume()
    receive(task)
  }

  private func startApple() {
    guard SFSpeechRecognizer.authorizationStatus() == .authorized,
          let recognizer = Self.recognizer, recognizer.isAvailable,
          let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(NativeVad.sampleRate), channels: 1, interleaved: false) else {
      appleDone = true
      return
    }
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.taskHint = .dictation
    if #available(iOS 16.0, *) { request.addsPunctuation = true }
    appleRequest = request
    appleFormat = format
    appleTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
      self?.queue.async {
        guard let self else { return }
        if let result {
          self.appleText = result.bestTranscription.formattedString
          if result.isFinal { self.appleDone = true }
        }
        if let error = error as NSError?, !self.appleDone {
          // "No speech detected": Apple heard nothing, which is an answer. Anything else: keep what it had, if anything.
          if error.code == 1110 && self.appleText == nil { self.appleText = "" }
          self.appleDone = true
        }
        self.settle()
      }
    }
  }

  /// Her voice, 16 kHz mono, as the phone hears it.
  func push(_ samples: [Int16]) {
    guard !samples.isEmpty else { return }
    queue.async {
      guard !self.closed else { return }
      if !self.streamFailed {
        let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
        if self.connecting {
          self.waitingAudio.append(data)
        } else {
          self.socket?.send(.data(data)) { _ in }
        }
      }
      if let request = self.appleRequest, let format = self.appleFormat,
         let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
         let out = buffer.floatChannelData {
        buffer.frameLength = AVAudioFrameCount(samples.count)
        for i in 0..<samples.count { out[0][i] = Float(samples[i]) / 32768 }
        request.append(buffer)
      }
    }
  }

  /// She is done: ask both ears for their last words, and wait for them a little. xAI's are waited for longer;
  /// once they are in, Apple gets a short grace and then its latest words are used as they are.
  func finish(timeout: TimeInterval = 2.0) async -> LineHeard {
    await withCheckedContinuation { cont in
      queue.async {
        self.finishing = cont
        if !self.streamFailed && !self.connecting {
          self.socket?.send(.string("{\"type\":\"audio.done\"}")) { _ in }
        }
        self.appleRequest?.endAudio()
        self.queue.asyncAfter(deadline: .now() + timeout) { self.settle(force: true) }
        self.settle()
      }
    }
  }

  /// The line was dropped (she tapped him, the call ended).
  func cancel() {
    queue.async {
      self.closed = true
      self.socket?.cancel(with: .goingAway, reason: nil)
      self.appleTask?.cancel()
      self.finishing?.resume(returning: LineHeard(stream: nil, apple: nil))
      self.finishing = nil
    }
  }

  private func receive(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .failure(let error):
        self.queue.async {
          if !self.streamDone && !self.closed {
            let code = (task.response as? HTTPURLResponse)?.statusCode ?? 0
            self.onTrouble?("stream \(code > 0 ? String(code) : error.localizedDescription)")
          }
          self.connecting = false
          self.streamFailed = true
          self.waitingAudio.removeAll()
          self.settle()
        }
      case .success(let message):
        if case .string(let text) = message {
          self.queue.async { self.handle(text) }
        }
        self.receive(task)
      }
    }
  }

  private func handle(_ text: String) {
    guard let data = text.data(using: .utf8),
          let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
    switch event["type"] as? String ?? "" {
    case "transcript.created":
      connecting = false
      for chunk in waitingAudio { socket?.send(.data(chunk)) { _ in } }
      waitingAudio.removeAll()
      onLive?()
      if finishing != nil { socket?.send(.string("{\"type\":\"audio.done\"}")) { _ in } }
    case "transcript.partial":
      guard event["is_final"] as? Bool == true else { return }
      if let piece = event["text"] as? String { finals.append(piece) }
      words += event["words"] as? [[String: Any]] ?? []
      if event["speech_final"] as? Bool == true { onFinished?() }
    case "transcript.done":
      doneText = event["text"] as? String ?? ""
      doneWords = event["words"] as? [[String: Any]] ?? []
      streamDone = true
      socket?.cancel(with: .normalClosure, reason: nil)
      settle()
    case "error":
      onTrouble?("stream \(event["message"] as? String ?? "error")")
      streamFailed = true
      socket?.cancel(with: .goingAway, reason: nil)
      settle()
    default:
      break
    }
  }

  /// Hands the result over once both ears have answered (or the wait is up).
  private func settle(force: Bool = false) {
    guard let cont = finishing else { return }
    let streamSettled = streamDone || streamFailed
    guard force || (streamSettled && appleDone) else {
      if streamSettled && !appleGrace {
        appleGrace = true
        queue.asyncAfter(deadline: .now() + 0.4) { self.settle(force: true) }
      }
      return
    }
    finishing = nil
    closed = true
    var heard = LineHeard(stream: nil, apple: appleText)
    if streamDone {
      // The final transcript is the whole line; the locked pieces are kept in case it only carries the last one.
      let joined = finals.joined()
      let done = doneText ?? ""
      heard.stream = done.count >= joined.count
        ? (text: done, words: doneWords.isEmpty ? words : doneWords)
        : (text: joined, words: words)
    }
    if !streamDone { socket?.cancel(with: .goingAway, reason: nil) }
    if !appleDone { appleTask?.cancel() }
    cont.resume(returning: heard)
  }
}
