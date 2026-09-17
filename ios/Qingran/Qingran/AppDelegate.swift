import AVFoundation
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    CallEngine.shared.prepareAudioSession()
    return true
  }

  func applicationDidBecomeActive(_ application: UIApplication) {
    if CallEngine.shared.inCall {
      CallEngine.shared.prepareAudioSession()
    }
  }
}
