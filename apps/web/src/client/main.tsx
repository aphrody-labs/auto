import { createRoot } from "react-dom/client";
import { App } from "./app";
import { appliquerTheme, themeEnregistre } from "@auto/ui/react";

appliquerTheme(themeEnregistre());
createRoot(document.getElementById("racine")!).render(<App />);
