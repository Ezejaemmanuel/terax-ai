import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "@fontsource/jetbrains-mono/cyrillic-400.css";
import "@fontsource/jetbrains-mono/cyrillic-700.css";
import "../styles/globals.css";

import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "@/modules/theme";
import { UpdaterProvider } from "@/modules/updater/UpdaterContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { SettingsApp } from "./SettingsApp";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

// The About section consumes UpdaterContext, so the settings window must supply
// it (without it, opening About threw and blanked the whole window). autoCheck
// is off here so the settings window doesn't redundantly check alongside main.
ReactDOM.createRoot(
  document.getElementById("settings-root") as HTMLElement,
).render(
  <ThemeProvider>
    <ErrorBoundary label="settings window">
      <UpdaterProvider autoCheck={false}>
        <SettingsApp />
      </UpdaterProvider>
    </ErrorBoundary>
  </ThemeProvider>,
);

const showWindow = () => {
  getCurrentWindow()
    .show()
    .catch((e) => console.error("settings show failed:", e));
};
setTimeout(showWindow, 50);
setTimeout(showWindow, 500);
