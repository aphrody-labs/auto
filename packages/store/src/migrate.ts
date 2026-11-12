import { connectMigrations, migrate } from "./db";

const sql = connectMigrations();
const applied = await migrate(sql);
console.log(applied.length ? `migrations appliquées : ${applied.join(", ")}` : "schéma à jour");
await sql.close();
