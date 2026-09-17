import SwiftUI

@main
struct QingranApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

  var body: some Scene {
    WindowGroup {
      RootView()
        .preferredColorScheme(.dark)
        .statusBarHidden(false)
    }
  }
}
