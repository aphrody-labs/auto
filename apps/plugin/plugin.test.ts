// Le plugin reste cohérent avec l'API et la CLI : manifeste lisible, serveur MCP distant (OAuth) sur /mcp,
// compétence nommée ; le serveur stdio `auto mcp` reste disponible pour les usages sans navigateur.
import { expect, test } from "bun:test";

const dir = new URL("./", import.meta.url);
const lire = (f: string) => Bun.file(new URL(f, dir)).json();

test("manifeste, serveur MCP et compétence", async () => {
  const p = await lire(".claude-plugin/plugin.json");
  expect(p).toMatchObject({ name: "auto", version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
  const mcp = await lire(".mcp.json");
  // Serveur distant : aucun jeton dans la configuration, le client s'authentifie par OAuth 2.1 (navigateur).
  expect(mcp.mcpServers.auto).toEqual({ type: "http", url: "${AUTO_MCP_URL:-https://auto.aphrody.com/mcp}" });
  const skill = await Bun.file(new URL("skills/auto/SKILL.md", dir)).text();
  expect(skill).toMatch(/^---\nname: auto\ndescription: .+\n---\n/);
});

test("la CLI expose la commande mcp utilisée par le plugin", async () => {
  const aide = await Bun.$`bun ${Bun.fileURLToPath(new URL("../cli/src/cli.ts", dir))} aide`.text();
  expect(aide).toContain("auto mcp");
});
