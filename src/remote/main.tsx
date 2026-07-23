import ReactDOM from "react-dom/client";
import { RemoteErrorBoundary } from "@/remote/components/RemoteErrorBoundary";
import { RemoteApp } from "@/remote/RemoteApp";
import { RemotePrefsProvider } from "@/remote/lib/prefs";
import "@/remote/remote.css";

ReactDOM.createRoot(
  document.getElementById("remote-root") as HTMLElement,
).render(
  <RemoteErrorBoundary>
    <RemotePrefsProvider>
      <RemoteApp />
    </RemotePrefsProvider>
  </RemoteErrorBoundary>,
);
