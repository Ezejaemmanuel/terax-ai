import ReactDOM from "react-dom/client";
import { RemoteErrorBoundary } from "@/remote/components/RemoteErrorBoundary";
import { RemoteApp } from "@/remote/RemoteApp";
import "@/remote/remote.css";

ReactDOM.createRoot(
  document.getElementById("remote-root") as HTMLElement,
).render(
  <RemoteErrorBoundary>
    <RemoteApp />
  </RemoteErrorBoundary>,
);
