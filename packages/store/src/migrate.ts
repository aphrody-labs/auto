import { connect, migrate } from "./db";

const sql = connect();
const applied = await migrate(sql);
console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Database schema up to date");
await sql.close();
