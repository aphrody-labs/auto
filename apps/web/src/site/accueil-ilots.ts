// Point d'entrée navigateur de la vitrine en production : la page est prérendue au build (construction.tsx),
// seuls le suivi du thème et les îlots (onglets, film) s'exécutent ; React n'est pas téléchargé.
import { activerIlots } from "./ilots";
import "./site";

activerIlots();
