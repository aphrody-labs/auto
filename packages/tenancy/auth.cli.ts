// Configuration lue par `bunx auth@latest generate` (schéma SQL de référence, voir docs/AUTH.md).
import { connect } from "@auto/store";
import { creerAuth } from "./src/auth";

export const auth = creerAuth(connect());
