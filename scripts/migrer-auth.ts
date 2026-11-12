// Reprise idempotente de l'ancienne double authentification vers Better Auth (aussi lancée au démarrage de
// l'API). Usage, à la racine du dépôt, avec DATABASE_URL et AUTO_CLE_MAITRE : bun scripts/migrer-auth.ts
import { connect, migrate } from "../packages/store/src/db";
import { authDe, migrerDeuxFacteurs, synchroniserOperateurs } from "../packages/tenancy/src/index";

const sql = connect();
await migrate(sql);
console.log(`2FA reprise : ${await migrerDeuxFacteurs(sql, authDe(sql))} compte(s)`);
await synchroniserOperateurs(sql);
await sql.close();
