import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ClientPage } from "./client";
import { Dashboard } from "./dashboard";
import { Home } from "./home";

function useHashRoute(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const update = () => {
      setHash(location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return hash;
}

function App() {
  const parts = useHashRoute().replace(/^#\/?/, "").split("/");

  if (parts[0] === "p" && parts[1] && parts[2]) {
    return <Dashboard key={parts[1]} projectId={parts[1]} token={parts[2]} />;
  }
  if (parts[0] === "c" && parts[1]) return <ClientPage key={parts[1]} token={parts[1]} />;
  return <Home />;
}

createRoot(document.getElementById("root")!).render(<App />);
