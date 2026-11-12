// Génère src/react/symboles.gen.ts : tracés Material Symbols (Rounded, graisse 400, Apache-2.0) des seules icônes
// utilisées par auto. Aucune dépendance à l'exécution ; ajouter une icône = une ligne dans ICONES puis
// `bun run --cwd packages/ui symboles`.
import { dirname, join } from "node:path";

/** Nom dans le code → nom Material Symbols (https://fonts.google.com/icons?icon.style=Rounded). */
export const ICONES: Record<string, string> = {
  Activity: "monitoring",
  ArrowDown: "arrow_downward",
  ArrowLeft: "arrow_back",
  ArrowLeftRight: "sync_alt",
  ArrowRight: "arrow_forward",
  ArrowUp: "arrow_upward",
  BadgeEuro: "euro",
  Ban: "block",
  Banknote: "payments",
  BellRing: "notifications_active",
  Building2: "domain",
  CalendarDays: "calendar_month",
  CalendarPlus: "calendar_add_on",
  Check: "check",
  Bolt: "bolt",
  ExpandMore: "keyboard_arrow_down",
  Extension: "extension",
  Lock: "lock",
  Smartphone: "mobile",
  Terminal: "terminal",
  Workflow: "account_tree",
  Play: "play_arrow",
  History: "history",
  DataObject: "data_object",
  CircleAlert: "error",
  CircleCheck: "check_circle",
  CircleX: "cancel",
  ClockAlert: "alarm",
  Copy: "content_copy",
  CreditCard: "credit_card",
  FileCheck: "task",
  FileCode2: "code_blocks",
  FileDown: "download",
  FileInput: "upload_file",
  FileOutput: "file_export",
  FilePlus2: "note_add",
  FileSpreadsheet: "table_chart",
  FileText: "description",
  FolderOpen: "folder_open",
  ImageUp: "add_photo_alternate",
  Inbox: "inbox",
  KeyRound: "key",
  Landmark: "account_balance",
  LayoutDashboard: "dashboard",
  LogIn: "login",
  LogOut: "logout",
  Menu: "menu",
  Monitor: "desktop_windows",
  Moon: "dark_mode",
  Package: "inventory_2",
  PackagePlus: "add_box",
  Palette: "palette",
  Pencil: "edit",
  Percent: "percent",
  PlugZap: "power",
  Plus: "add",
  ReceiptText: "receipt_long",
  RotateCcw: "replay",
  Save: "save",
  Search: "search",
  Send: "send",
  Settings: "settings",
  ShieldCheck: "verified_user",
  Sun: "light_mode",
  Trash2: "delete",
  TriangleAlert: "warning",
  Undo2: "undo",
  Upload: "upload",
  UserPlus: "person_add",
  UserRound: "person",
  Users: "group",
  X: "close",
};

if (import.meta.main) {
  const racine = dirname(Bun.resolveSync("@material-symbols/svg-400/package.json", import.meta.dir));
  const lignes: string[] = [];
  for (const [nom, symbole] of Object.entries(ICONES)) {
    const svg = await Bun.file(join(racine, "rounded", `${symbole}.svg`)).text();
    const d = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]).join(" ");
    if (!d) throw new Error(`${symbole} : tracé introuvable`);
    lignes.push(`  ${nom}: ${JSON.stringify(d)},`);
  }
  const sortie = join(import.meta.dir, "../src/react/symboles.gen.ts");
  await Bun.write(
    sortie,
    `// Généré par scripts/symboles.ts depuis @material-symbols/svg-400 (Rounded, 400) : ne pas modifier à la main.
// Material Symbols, Google, licence Apache-2.0.
export const TRACES = {
${lignes.join("\n")}
} as const;
`,
  );
  console.log(`${lignes.length} symboles → ${sortie}`);
}
