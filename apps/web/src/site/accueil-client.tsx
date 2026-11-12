// Point d'entrée de la vitrine en développement (imports HTML de Bun.serve, HMR) : rendu React côté client puis
// mêmes îlots qu'en production. En production, construction.tsx prérend la page et charge accueil-ilots.ts.
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Accueil } from "./accueil";
import { activerIlots } from "./ilots";
import "./site";

const racine = createRoot(document.getElementById("racine")!);
flushSync(() => racine.render(<Accueil />));
activerIlots();
