import Foundation

enum QingranConfig {
  static let urlKey = "qingran.webURL"
  static let displayName = "清然"

  static var savedURLString: String {
    get { UserDefaults.standard.string(forKey: urlKey)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }
    set { UserDefaults.standard.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: urlKey) }
  }

  static var savedURL: URL? {
    let raw = savedURLString
    guard !raw.isEmpty else { return nil }
    let withScheme = raw.contains("://") ? raw : "https://\(raw)"
    return URL(string: withScheme)
  }

  static func looksLikeURL(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count > 8 else { return false }
    let withScheme = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
    guard let url = URL(string: withScheme), let host = url.host, host.contains(".") else { return false }
    return url.scheme == "https" || url.scheme == "http"
  }
}

/// Same rules and defaults as src/lib/lover/vad.ts. Her own numbers arrive with startNativeCall.
enum NativeVad {
  static let sampleRate = 16_000
  static let levelMs: Float = 60
  static let floorFallMs: Float = 250
  static let floorRiseMs: Float = 6_000
  static let floorRiseIdleMs: Float = 1_500
  static let floorMin: Float = 0.0015
  static let floorMax: Float = 0.05
  static let floorStart: Float = 0.006
  static let minSpeechMs: Float = 220
  static let preRollMs = 1_500
  /// While Qingran plays and this long after, the floor stays frozen and no turn starts (his voice still in the room).
  static let postPlaybackMs: Float = 300
  /// While he is still thinking about her last words, sound this long means she is going on with them.
  static let goOnHoldMs: Float = 250
}

struct NativeVadParams {
  var startMin: Float = 0.004
  var startMult: Float = 1.35
  var holdMin: Float = 0.0045
  var holdMult: Float = 1.25
  var startHoldMs: Float = 80
  var endWaitMs: Float = 1_500
  var maxUtteranceMs: Float = 600_000

  init() {}

  init(_ raw: [String: Any]?) {
    guard let raw else { return }
    func read(_ key: String) -> Float? {
      if let n = raw[key] as? NSNumber { return n.floatValue }
      return nil
    }
    startMin = read("startMin") ?? startMin
    startMult = read("startMult") ?? startMult
    holdMin = read("holdMin") ?? holdMin
    holdMult = read("holdMult") ?? holdMult
    startHoldMs = read("startHoldMs") ?? startHoldMs
    endWaitMs = read("endWaitMs") ?? endWaitMs
    maxUtteranceMs = read("maxUtteranceMs") ?? maxUtteranceMs
  }
}
