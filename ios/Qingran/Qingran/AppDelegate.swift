import AVFoundation
import UIKit
import UserNotifications

extension Notification.Name {
  static let qingranPushToken = Notification.Name("qingranPushToken")
  static let qingranPush = Notification.Name("qingranPush")
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    CallEngine.shared.prepareAudioSession()
    UNUserNotificationCenter.current().delegate = self
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
      guard granted else { return }
      DispatchQueue.main.async {
        application.registerForRemoteNotifications()
      }
    }
    return true
  }

  func applicationDidBecomeActive(_ application: UIApplication) {
    if CallEngine.shared.inCall {
      CallEngine.shared.prepareAudioSession()
    }
  }

  func applicationDidEnterBackground(_ application: UIApplication) {
    application.isIdleTimerDisabled = false
  }

  func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    let env: String
    #if DEBUG
    env = "sandbox"
    #else
    env = "production"
    #endif
    UserDefaults.standard.set(token, forKey: "qingran.pushToken")
    UserDefaults.standard.set(env, forKey: "qingran.pushEnv")
    NotificationCenter.default.post(name: .qingranPushToken, object: nil, userInfo: ["token": token, "env": env])
  }

  func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    UserDefaults.standard.set(error.localizedDescription, forKey: "qingran.pushError")
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([])
    NotificationCenter.default.post(name: .qingranPush, object: nil)
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    NotificationCenter.default.post(name: .qingranPush, object: nil, userInfo: ["open": true])
    completionHandler()
  }
}
