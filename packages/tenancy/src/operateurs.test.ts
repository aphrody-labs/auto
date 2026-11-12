import { expect, test } from "bun:test";
import { testDb } from "@auto/store";
import { synchroniserOperateurs } from "./operateurs";
test("Super-admin : deux adresses Linux/Windows, vérification et retrait sans sérialisation de tableaux native", async () => {
  const { sql, drop } = await testDb(),
    avant = Bun.env.AUTO_SUPER_ADMIN_EMAILS;
  try {
    for (const [email, verifie] of [
      ["un@example.test", true],
      ["deux@example.test", true],
      ["non-verifie@example.test", false],
      ["autre@example.test", true],
    ] as const)
      await sql`INSERT INTO app_user(email,name,email_verified)VALUES(${email},'QA',${verifie})`;
    Bun.env.AUTO_SUPER_ADMIN_EMAILS = "UN@example.test,deux@example.test,non-verifie@example.test";
    await synchroniserOperateurs(sql);
    const rows = await sql<{ email: string; role: string }[]>`SELECT email,role FROM app_user ORDER BY email`;
    expect(rows.find((x) => x.email === "un@example.test")!.role).toBe("admin");
    expect(rows.find((x) => x.email === "deux@example.test")!.role).toBe("admin");
    expect(rows.find((x) => x.email === "non-verifie@example.test")!.role).toBe("user");
    expect(rows.find((x) => x.email === "autre@example.test")!.role).toBe("user");
    Bun.env.AUTO_SUPER_ADMIN_EMAILS = "un@example.test";
    await synchroniserOperateurs(sql);
    expect((await sql`SELECT role FROM app_user WHERE email='deux@example.test'`)[0]!.role).toBe("user");
  } finally {
    if (avant === undefined) delete Bun.env.AUTO_SUPER_ADMIN_EMAILS;
    else Bun.env.AUTO_SUPER_ADMIN_EMAILS = avant;
    await drop();
  }
}, 30000);
